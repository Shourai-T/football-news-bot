import type { AnalyzedArticle } from "./editorial-types.ts";
import { scoreArticle } from "./editorial.ts";
import { canonicalizeUrl } from "./url-normalization.ts";

export function sameEvent(a: AnalyzedArticle, b: AnalyzedArticle): boolean {
  if (canonicalizeUrl(a.article.canonicalUrl) === canonicalizeUrl(b.article.canonicalUrl)) return true;
  const x = a.features, y = b.features;
  if (x.type !== y.type || x.type === "general" || !x.event || !y.event) return false;
  if (JSON.stringify(x.entities) !== JSON.stringify(y.entities) || x.event.key !== y.event.key ||
      JSON.stringify(x.event.materialNumbers) !== JSON.stringify(y.event.materialNumbers)) return false;
  const left = new Set(x.titleTokens), right = new Set(y.titleTokens);
  if (!left.size || !right.size) return false;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / new Set([...left, ...right]).size >= 0.80;
}

export function groupCurrentEvents(items: readonly AnalyzedArticle[], now: Date): AnalyzedArticle[] {
  const sorted = items.map((item) => ({ item, score: scoreArticle(item, now).total })).sort((a, b) =>
    Number(b.item.features.directOfficial) - Number(a.item.features.directOfficial) || b.score - a.score ||
    b.item.article.publishedAt.getTime() - a.item.article.publishedAt.getTime() ||
    compareUrls(a.item.article.canonicalUrl, b.item.article.canonicalUrl));
  const groups: AnalyzedArticle[][] = [];
  for (const { item } of sorted) {
    const group = groups.find((members) => members.every((member) => sameEvent(member, item)));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups.map((group) => group[0]!);
}

function compareUrls(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
