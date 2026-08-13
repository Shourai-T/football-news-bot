import type { Article } from "./domain-types.ts";

const MAX_AGE_MS = 72 * 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export function selectBestCandidate(
  entries: readonly Article[],
  seenUrls: ReadonlySet<string>,
  now: Date,
): Article | null {
  return entries
    .filter((entry) => !seenUrls.has(entry.canonicalUrl))
    .filter(
      (entry) =>
        entry.topicScore > 0 &&
        now.getTime() - entry.publishedAt.getTime() <= MAX_AGE_MS &&
        entry.publishedAt.getTime() - now.getTime() <= MAX_FUTURE_CLOCK_SKEW_MS,
    )
    .sort(
      (left, right) =>
        right.sourcePriority - left.sourcePriority ||
        right.topicScore - left.topicScore ||
        right.publishedAt.getTime() - left.publishedAt.getTime(),
    )[0] ?? null;
}
