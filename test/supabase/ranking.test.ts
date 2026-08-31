import { describe, expect, it } from "vitest";
import { selectEditorialCandidate } from "../../supabase/functions/_shared/ranking";
import type { Article } from "../../supabase/functions/_shared/domain-types";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const BASE: Article = {
  title: "Transfer target",
  excerpt: "",
  sourceName: "BBC",
  canonicalUrl: "https://bbc.test/transfer",
  publishedAt: new Date("2026-08-10T11:00:00.000Z"),
  sourcePriority: 10,
  topicScore: 1,
};

describe("Supabase candidate ranking", () => {
  it("rejects seen, off-topic, older-than-72-hours, and far-future entries", () => {
    const valid = { ...BASE, canonicalUrl: "https://valid.test" };
    const entries: Article[] = [
      BASE,
      { ...BASE, canonicalUrl: "https://off-topic.test", topicScore: 0 },
      {
        ...BASE,
        canonicalUrl: "https://stale.test",
        publishedAt: new Date("2026-08-07T11:59:59.999Z"),
      },
      {
        ...BASE,
        canonicalUrl: "https://future.test",
        publishedAt: new Date("2026-08-10T12:05:00.001Z"),
      },
      valid,
    ];

    expect(selectEditorialCandidate(
      entries,
      new Set([BASE.canonicalUrl]),
      NOW,
      { delivered: [], selected: [] },
    )?.article.canonicalUrl).toBe(new URL(valid.canonicalUrl).toString());
  });
});
