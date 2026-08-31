import type { Article } from "./domain-types.ts";
import type { AnalyzedArticle, EditorialFeatures, EditorialType, EventFeatures, ScoreParts } from "./editorial-types.ts";
import { resolveSource, type SourcePolicy } from "./feed-config.ts";
import { parsePublicationDate } from "./feed-date.ts";

export const CLASSIFIER_VERSION = "editorial-v1";
const CLUBS = ["arsenal", "aston villa", "atletico madrid", "barcelona", "bayern munich", "borussia dortmund",
  "chelsea", "inter milan", "juventus", "liverpool", "manchester city", "manchester united", "newcastle united",
  "paris saint germain", "real madrid", "tottenham", "ac milan"];
const PLAYERS = ["messi", "ronaldo", "bellingham", "de bruyne", "haaland", "harry kane", "lewandowski",
  "mbappe", "neymar", "salah", "vinicius", "yamal"];
const COMPETITIONS = ["champions league", "premier league"];
const EXTRA_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "manchester united": ["man utd", "man united"], "manchester city": ["man city"],
  "paris saint germain": ["psg"], "champions league": ["ucl"], "premier league": ["epl"],
};
const IDENTITIES = [
  ...CLUBS.map((name) => ({ id: `club:${name.replaceAll(" ", "-")}`, name })),
  ...PLAYERS.map((name) => ({ id: `player:${name.replaceAll(" ", "-")}`, name })),
  ...COMPETITIONS.map((name) => ({ id: `competition:${name.replaceAll(" ", "-")}`, name })),
].map((identity) => ({ ...identity, aliases: [identity.name, ...(EXTRA_ALIASES[identity.name] ?? [])] }));
const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "by", "with", "is", "are", "was", "were"]);
const UNCERTAIN = /\b(?:not|never|denies|denied|unconfirmed|could|may|might|would|rumours?|rumors?|reportedly|linked with)\b/;
const TRANSFER = /\b(?:joins|joined|signs for|signed for|agrees to join|agreed to join|complete[sd]? (?:a |the )?transfer)\b/;
const CONTRACT = /\b(?:extends?|extended|terminates?|terminated|signs?|signed) (?:a |the |new )?contract\b/;
const INJURY = /\b(?:suffers? (?:an? )?injury|suffered (?:an? )?injury|ruled out|returns? from injury)\b/;
const MATCH = /\b(?:beat|beats|defeats?|defeated|draw with|draws with|drew with)\b/;

export function normalizeWords(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function analyzeArticle(article: Article, policy = resolveSource(article.sourceName)): AnalyzedArticle {
  const title = normalizeWords(article.title);
  const text = normalizeWords(`${article.title}\n${article.excerpt}`);
  const ids = IDENTITIES.filter(({ aliases }) => aliases.some((alias) => containsPhrase(text, alias)))
    .map(({ id }) => id).sort();
  const classification = classify(title);
  const result = classification.type === "general" ? classify(text) : classification;
  const explicitDevelopment = result.explicitDevelopment && !UNCERTAIN.test(text);
  const features: EditorialFeatures = {
    sourceId: policy.id,
    entities: ids.filter((id) => !id.startsWith("competition:")),
    competitions: ids.filter((id) => id.startsWith("competition:")),
    type: result.type, explicitDevelopment,
    directOfficial: explicitDevelopment && directlyConfirmed(article, text, policy),
    credibility: policy.credibility,
    titleTokens: [...new Set(title.split(" ").filter((token) => token && !STOP_WORDS.has(token)))].sort(),
    event: null,
  };
  features.event = extractEventFeatures(article, features);
  return { article, features };
}

export function scoreArticle(item: AnalyzedArticle, now: Date): ScoreParts {
  const f = item.features;
  const event = f.directOfficial ? 30 : f.explicitDevelopment &&
    ["transfer", "contract", "injury", "match"].includes(f.type) ? 20 :
    ["quote", "stat"].includes(f.type) ? 10 : 0;
  const subjects = Number(f.entities.some((id) => id.startsWith("player:"))) * 10 +
    Number(f.entities.some((id) => id.startsWith("club:"))) * 5 + Number(f.competitions.length > 0) * 5;
  const age = Math.max(0, now.getTime() - item.article.publishedAt.getTime());
  const freshness = 30 * Math.max(0, 1 - age / (72 * 3_600_000));
  const source = f.directOfficial ? 20 : f.credibility;
  return { event, subjects, freshness, source, total: event + subjects + freshness + source };
}

function classify(text: string): { type: EditorialType; explicitDevelopment: boolean } {
  const explicit: EditorialType[] = [];
  if (TRANSFER.test(text)) explicit.push("transfer");
  if (CONTRACT.test(text)) explicit.push("contract");
  if (INJURY.test(text)) explicit.push("injury");
  if (MATCH.test(text)) explicit.push("match");
  if (explicit.length === 1) return { type: explicit[0]!, explicitDevelopment: true };
  if (explicit.length > 1) return { type: "general", explicitDevelopment: false };
  let type: EditorialType = "general";
  if (/\b(?:transfers?|linked with)\b/.test(text)) type = "transfer";
  else if (/\bcontracts?\b/.test(text)) type = "contract";
  else if (/\b(?:injur(?:y|ies)|injured)\b/.test(text)) type = "injury";
  else if (/\b(?:says|said|quote)\b/.test(text)) type = "quote";
  else if (/\b\d+ (?:career |league )?(?:goals|assists|appearances|clean sheets)\b/.test(text)) type = "stat";
  return { type, explicitDevelopment: false };
}

function directlyConfirmed(article: Article, text: string, policy: SourcePolicy): boolean {
  if (policy.kind !== "official" || UNCERTAIN.test(text) || /\b(?:according to|media watch)\b/.test(text)) return false;
  if (!/\b(?:we (?:can )?confirm|the club confirms|the club announces)\b/.test(text)) return false;
  try {
    const url = new URL(article.canonicalUrl);
    return url.protocol === "https:" && policy.articleHosts.includes(url.hostname) &&
      !/media[-_/]?watch/i.test(url.pathname) &&
      policy.directAnnouncementPaths.some((path) => path.endsWith("/") && url.pathname.startsWith(path));
  } catch { return false; }
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function extractEventFeatures(article: Article, features: EditorialFeatures): EventFeatures | null {
  const title = normalizeWords(article.title);
  const fullText = normalizeWords(`${article.title} ${article.excerpt}`);
  if (/\b(?:not|never|denies|denied|could|may|might|would|or)\b/.test(fullText)) return null;
  let canonical = title;
  const aliases = IDENTITIES.flatMap(({ id, aliases }) => aliases.map((alias) => ({ id, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { id, alias } of aliases) {
    canonical = canonical.replace(new RegExp(`\\b${alias}\\b`, "g"), id);
  }
  const players = features.entities.filter((id) => id.startsWith("player:"));
  const dates = [...article.title.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(([date]) => date);
  const date = dates.length === 1 && parsePublicationDate(`${dates[0]}T00:00:00Z`, "standard") ? dates[0]! : null;
  let key: readonly string[] | null = null;
  if (features.type === "transfer" && players.length === 1) {
    const matches = [...canonical.matchAll(/\b(player:[a-z-]+) (joins|joined|signs for|signed for|agrees to join|agreed to join|linked with) (club:[a-z-]+)\b/g)];
    if (matches.length === 1) {
      const m = matches[0]!;
      const stage = m[2] === "linked with" ? "rumor" : m[2]!.startsWith("agree") ? "agreed" : "completed";
      key = ["transfer", m[1]!, m[3]!, stage];
    }
  } else if (features.type === "contract" && players.length === 1) {
    const match = /\b(player:[a-z-]+) (extends?|extended|terminates?|terminated) (?:a |the |new )?contract until (\d{4})\b/.exec(canonical);
    if (match) key = ["contract", match[1]!, match[2]!.startsWith("extend") ? "extend" : "terminate", match[3]!];
  } else if (features.type === "injury" && players.length === 1 && date) {
    const match = /\b(player:[a-z-]+) (suffers? (?:an? )?injury|suffered (?:an? )?injury|returns? from injury)\b/.exec(canonical);
    if (match) key = ["injury", match[1]!, match[2]!.startsWith("return") ? "return" : "injury", date];
  } else if (features.type === "match" && date) {
    const match = /\b(club:[a-z-]+) (beat|beats|defeats?|defeated|draws? with|drew with) (club:[a-z-]+) (\d+) (\d+)\b/.exec(canonical);
    if (match) key = ["match", match[1]!, match[3]!, match[2]!.startsWith("dr") ? "draw" : "win", match[4]!, match[5]!, date];
  } else if (features.type === "quote" && players.length === 1) {
    const quotes = [...article.title.matchAll(/["“]([^"”]+)["”]/g)];
    if (quotes.length === 1) {
      const quote = normalizeWords(quotes[0]![1]!);
      if (quote.split(" ").length >= 8 && /\bplayer:[a-z-]+ (?:says|said)\b/.test(canonical)) {
        key = ["quote", players[0]!, quote];
      }
    }
  } else if (features.type === "stat" && players.length === 1) {
    const match = /\b(player:[a-z-]+) reaches (\d+) career (goals|assists|appearances|clean sheets)\b/.exec(canonical);
    if (match) key = ["stat", match[1]!, "career", match[3]!, match[2]!];
  }
  if (!key) return null;
  const materialNumbers = [...new Set((`${article.title} ${article.excerpt}`
    .match(/(?:[€£$]\s*)?\d+(?:[.,]\d+)*(?:\s*(?:million|billion|[mb]))?\b/gi) ?? [])
    .map((value) => value.replace(/\s/g, "").toLowerCase()))].sort();
  return { key: JSON.stringify(key), materialNumbers };
}
