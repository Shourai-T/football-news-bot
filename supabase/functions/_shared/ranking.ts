import type { Article } from "./domain-types.ts";
import { analyzeArticle, CLASSIFIER_VERSION, scoreArticle } from "./editorial.ts";
import type { AnalyzedArticle, SelectionHistory, SelectionResult } from "./editorial-types.ts";
import { groupCurrentEvents, sameEvent } from "./event-dedup.ts";
import { canonicalizeUrl } from "./url-normalization.ts";

const MAX_AGE_MS = 72 * 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export function selectEditorialCandidate(
  entries: readonly Article[],
  seenUrls: ReadonlySet<string>,
  now: Date,
  history: SelectionHistory,
): SelectionResult | null {
  if (!Number.isFinite(now.getTime())) return null;
  const normalizedSeen = new Set<string>();
  for (const url of seenUrls) {
    try { normalizedSeen.add(canonicalizeUrl(url)); } catch { /* Ignore corrupt caller input. */ }
  }
  const eligible = entries.flatMap((entry) => normalizeEligible(entry, normalizedSeen, now));
  const recentHistory = history.selected.filter((entry) => isWithinTimeWindow(entry, now))
    .map((entry) => analyzeArticle(entry));
  const uniqueEvents = groupCurrentEvents(eligible.map((entry) => analyzeArticle(entry)), now)
    .filter((candidate) => !recentHistory.some((selected) => sameEvent(candidate, selected)));
  if (!uniqueEvents.length) return null;

  const counts = countDelivered(history.delivered.map((entry) => analyzeArticle(entry)));
  const ranked = uniqueEvents.map((item) => ({ item, score: scoreArticle(item, now), excess: excessFor(item, counts) }));
  const minimumExcess = Math.min(...ranked.map(({ excess }) => excess));
  const pool = minimumExcess === 0 ? ranked.filter(({ excess }) => excess === 0) :
    ranked.filter(({ excess }) => excess === minimumExcess);
  pool.sort((a, b) => b.score.total - a.score.total ||
    b.item.article.publishedAt.getTime() - a.item.article.publishedAt.getTime() ||
    compareText(a.item.article.canonicalUrl, b.item.article.canonicalUrl));
  const best = pool[0]!;
  return { article: best.item.article, sourceId: best.item.features.sourceId, score: best.score,
    diversityFallback: minimumExcess > 0, excess: best.excess, classifierVersion: CLASSIFIER_VERSION };
}

function normalizeEligible(entry: Article, seen: ReadonlySet<string>, now: Date): Article[] {
  if (!entry.title.trim() || entry.topicScore <= 0 || !isWithinTimeWindow(entry, now)) return [];
  try {
    const canonicalUrl = canonicalizeUrl(entry.canonicalUrl);
    if (new URL(canonicalUrl).protocol !== "https:" || seen.has(canonicalUrl)) return [];
    return [canonicalUrl === entry.canonicalUrl ? entry : { ...entry, canonicalUrl }];
  } catch { return []; }
}

function isWithinTimeWindow(entry: Article, now: Date): boolean {
  const published = entry.publishedAt.getTime();
  return Number.isFinite(published) && now.getTime() - published <= MAX_AGE_MS &&
    published - now.getTime() <= MAX_FUTURE_CLOCK_SKEW_MS;
}

function dimensions(item: AnalyzedArticle): string[] {
  return [`source:${item.features.sourceId}`, `type:${item.features.type}`,
    ...item.features.entities.map((entity) => `entity:${entity}`)];
}

function countDelivered(items: readonly AnalyzedArticle[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const key of new Set(dimensions(item))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function excessFor(item: AnalyzedArticle, counts: ReadonlyMap<string, number>): number {
  return dimensions(item).reduce((sum, key) => sum + Math.max(0, (counts.get(key) ?? 0) + 1 - 2), 0);
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
