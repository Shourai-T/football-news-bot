import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Article, FeedDefinition } from "./domain-types.ts";

type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  textNodeName: "#text",
  trimValues: true,
});

const TOPIC_PATTERNS = [
  /\bmessi\b/i,
  /\bronaldo\b/i,
  /\btransfers?\b/i,
  /\bbreaking(?:\s+football)?(?:\s+news)?\b/i,
  /\b(?:arsenal|aston villa|atletico madrid|barcelona|bayern munich|borussia dortmund|chelsea|inter milan|juventus|liverpool|manchester city|manchester united|newcastle united|paris saint-germain|psg|real madrid|tottenham|ac milan)\b/i,
  /\b(?:bellingham|de bruyne|haaland|harry kane|lewandowski|mbapp[eé]|neymar|salah|vin[ií]cius|yamal)\b/i,
  /\b(?:champions league|ucl)\b/i,
  /\b(?:premier league|epl)\b/i,
];

export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "fbclid" || key === "gclid") {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  return url.toString();
}

export async function fetchFeedEntries(
  feeds: readonly FeedDefinition[],
  fetcher: typeof fetch,
  now: Date,
  onFeedFailure?: (feedName: string) => void,
): Promise<Article[]> {
  void now;
  const results = await Promise.allSettled(
    feeds.map(async (feed) => ({
      feed,
      entries: await fetchSingleFeed(feed, fetcher),
    })),
  );
  const bestByUrl = new Map<string, Article>();

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      onFeedFailure?.(feeds[index]!.name);
      return;
    }
    for (const entry of result.value.entries) {
      const existing = bestByUrl.get(entry.canonicalUrl);
      if (!existing || isBetterDuplicate(entry, existing)) {
        bestByUrl.set(entry.canonicalUrl, entry);
      }
    }
  });
  return [...bestByUrl.values()];
}

async function fetchSingleFeed(
  feed: FeedDefinition,
  fetcher: typeof fetch,
): Promise<Article[]> {
  const response = await fetcher(feed.url, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("rss_http_error");
  const xml = await response.text();
  if (XMLValidator.validate(xml) !== true) throw new Error("rss_invalid_xml");
  const document = asRecord(parser.parse(xml)) ?? {};
  return [
    ...extractRssItems(document, feed),
    ...extractAtomEntries(document, feed),
  ];
}

function extractRssItems(document: XmlRecord, feed: FeedDefinition): Article[] {
  const channel = asRecord(asRecord(document.rss)?.channel);
  return asArray(channel?.item).map(asRecord)
    .flatMap((entry) => normalizeEntry(entry, feed, "rss"));
}

function extractAtomEntries(document: XmlRecord, feed: FeedDefinition): Article[] {
  const atom = asRecord(document.feed);
  return asArray(atom?.entry).map(asRecord)
    .flatMap((entry) => normalizeEntry(entry, feed, "atom"));
}

function normalizeEntry(
  entry: XmlRecord | undefined,
  feed: FeedDefinition,
  format: "rss" | "atom",
): Article[] {
  if (!entry) return [];
  const title = textValue(entry.title);
  const rawUrl = format === "rss" ? textValue(entry.link) : atomLink(entry.link);
  const publishedAt = publicationDate(
    format === "rss"
      ? entry.pubDate ?? entry.isoDate ?? entry.date
      : entry.published ?? entry.updated,
  );
  if (!title || !rawUrl || !publishedAt) return [];

  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(rawUrl);
    if (new URL(canonicalUrl).protocol !== "https:") return [];
  } catch {
    return [];
  }

  const excerpt = stripMarkup(textValue(
    format === "rss"
      ? entry.description ?? entry["content:encoded"]
      : entry.summary ?? entry.content,
  ));
  return [{
    title,
    excerpt,
    sourceName: feed.name,
    canonicalUrl,
    publishedAt,
    sourcePriority: feed.priority,
    topicScore: scoreTopic(`${title}\n${excerpt}`),
  }];
}

function isBetterDuplicate(candidate: Article, existing: Article): boolean {
  return candidate.sourcePriority > existing.sourcePriority ||
    (candidate.sourcePriority === existing.sourcePriority &&
      (candidate.topicScore > existing.topicScore ||
        (candidate.topicScore === existing.topicScore &&
          candidate.publishedAt > existing.publishedAt)));
}

function atomLink(value: unknown): string {
  for (const link of asArray(value).map(asRecord)) {
    if (!link) continue;
    const rel = textValue(link["@_rel"]);
    const href = textValue(link["@_href"]);
    if (href && (!rel || rel === "alternate")) return href;
  }
  return "";
}

function publicationDate(value: unknown): Date | null {
  const parsed = new Date(textValue(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function scoreTopic(value: string): number {
  return TOPIC_PATTERNS.reduce(
    (score, pattern) => score + Number(pattern.test(value)),
    0,
  );
}

function asRecord(value: unknown): XmlRecord | undefined {
  return typeof value === "object" && value !== null
    ? value as XmlRecord
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  const record = asRecord(value);
  return record ? textValue(record["#text"]) : "";
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
