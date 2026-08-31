import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Article, FeedDefinition } from "./domain-types.ts";
import { parsePublicationDate } from "./feed-date.ts";
import { resolveSource } from "./feed-config.ts";
import { canonicalizeUrl } from "./url-normalization.ts";
export { canonicalizeUrl } from "./url-normalization.ts";

type XmlRecord = Record<string, unknown>;

export interface FeedDiagnostic {
  sourceId: string;
  outcome: "ok" | "empty" | "failed";
  category: "none" | "timeout" | "network" | "http" | "invalid_xml" |
    "unsupported_structure" | "all_items_invalid";
  items: number;
  usable: number;
  invalidDate: number;
  invalidUrl: number;
  invalidContent: number;
}

class FeedError extends Error {
  constructor(readonly category: FeedDiagnostic["category"]) { super(category); }
}

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

export async function fetchFeedEntries(
  feeds: readonly FeedDefinition[],
  fetcher: typeof fetch,
  now: Date,
  onFeedFailure?: (feedName: string) => void,
  onDiagnostic?: (diagnostic: FeedDiagnostic) => void,
): Promise<Article[]> {
  void now;
  const results = await Promise.allSettled(
    feeds.map(async (feed) => ({
      feed,
      result: await fetchSingleFeed(feed, fetcher),
    })),
  );
  const bestByUrl = new Map<string, Article>();

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      observe(onFeedFailure, feeds[index]!.name);
      observe(onDiagnostic, { ...newDiagnostic(feeds[index]!), outcome: "failed", category: "network" });
      return;
    }
    const { entries, diagnostic } = result.value.result;
    if (diagnostic.outcome === "failed") observe(onFeedFailure, result.value.feed.name);
    observe(onDiagnostic, diagnostic);
    for (const entry of entries) {
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
): Promise<{ entries: Article[]; diagnostic: FeedDiagnostic }> {
  const diagnostic = newDiagnostic(feed);
  try {
    const response = await fetcher(feed.url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new FeedError("http");
    const xml = await response.text();
    if (XMLValidator.validate(xml) !== true) throw new FeedError("invalid_xml");
    const document = asRecord(parser.parse(xml)) ?? {};
    const rss = asRecord(document.rss);
    const isRss = Object.hasOwn(rss ?? {}, "channel");
    const isAtom = Object.hasOwn(document, "feed");
    if (!isRss && !isAtom) throw new FeedError("unsupported_structure");
    const format = isRss ? "rss" : "atom";
    const raw = isRss ? asRecord(rss?.channel)?.item : asRecord(document.feed)?.entry;
    const items = asArray(raw);
    diagnostic.items = items.length;
    const entries = items.flatMap((item) => normalizeEntry(asRecord(item), feed, format, diagnostic));
    diagnostic.usable = entries.length;
    if (items.length > 0 && entries.length === 0) throw new FeedError("all_items_invalid");
    diagnostic.outcome = entries.length ? "ok" : "empty";
    return { entries, diagnostic };
  } catch (error) {
    diagnostic.outcome = "failed";
    diagnostic.category = error instanceof FeedError ? error.category :
      error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "network";
    return { entries: [], diagnostic };
  }
}

function normalizeEntry(
  entry: XmlRecord | undefined,
  feed: FeedDefinition,
  format: "rss" | "atom",
  diagnostic: FeedDiagnostic,
): Article[] {
  if (!entry || !textValue(entry.title)) {
    diagnostic.invalidContent += 1;
    return [];
  }
  const title = textValue(entry.title);
  const rawUrl = format === "rss" ? textValue(entry.link) : atomLink(entry.link);
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(rawUrl);
    if (new URL(canonicalUrl).protocol !== "https:") throw new Error("invalid_url");
  } catch {
    diagnostic.invalidUrl += 1;
    return [];
  }
  const publishedAt = parsePublicationDate(textValue(format === "rss"
    ? entry.pubDate ?? entry.isoDate ?? entry.date
    : entry.published ?? entry.updated), resolveSource(feed.name).datePolicy);
  if (!publishedAt) {
    diagnostic.invalidDate += 1;
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

function newDiagnostic(feed: FeedDefinition): FeedDiagnostic {
  return { sourceId: resolveSource(feed.name).id, outcome: "empty", category: "none",
    items: 0, usable: 0, invalidDate: 0, invalidUrl: 0, invalidContent: 0 };
}

function observe<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try { callback?.(value); } catch { /* Observability must not discard usable news. */ }
}
