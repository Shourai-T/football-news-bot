import type { Article } from "./domain-types.ts";
import type { AnalyzedArticle, EditorialType, ScoreParts } from "./editorial-types.ts";
import { resolveSource, type SourcePolicy } from "./feed-config.ts";

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
  return { article, features: {
    sourceId: policy.id,
    entities: ids.filter((id) => !id.startsWith("competition:")),
    competitions: ids.filter((id) => id.startsWith("competition:")),
    type: result.type, explicitDevelopment,
    directOfficial: explicitDevelopment && directlyConfirmed(article, text, policy),
    credibility: policy.credibility,
    titleTokens: [...new Set(title.split(" ").filter((token) => token && !STOP_WORDS.has(token)))].sort(),
    event: null,
  } };
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
