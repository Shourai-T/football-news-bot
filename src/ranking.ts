import type { Article } from "./types";

const MAX_AGE_MS = 72 * 60 * 60 * 1000;

export function selectBestCandidate(
  entries: Article[],
  seenUrls: ReadonlySet<string>,
  now: Date,
): Article | null {
  return entries
    .filter((entry) => !seenUrls.has(entry.canonicalUrl))
    .filter(
      (entry) =>
        entry.topicScore > 0 &&
        now.getTime() - entry.publishedAt.getTime() <= MAX_AGE_MS,
    )
    .sort(
      (a, b) =>
        b.sourcePriority - a.sourcePriority ||
        b.topicScore - a.topicScore ||
        b.publishedAt.getTime() - a.publishedAt.getTime(),
    )[0] ?? null;
}
