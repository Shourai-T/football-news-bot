import { describe, expect, it } from "vitest";
import { selectBestCandidate } from "../../supabase/functions/_shared/ranking";
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
  it("prioritizes source, then topic score, then publication time", () => {
    const entries: Article[] = [
      { ...BASE, canonicalUrl: "https://a.test", sourcePriority: 5, topicScore: 1 },
      { ...BASE, canonicalUrl: "https://b.test", sourcePriority: 5, topicScore: 2 },
      {
        ...BASE,
        canonicalUrl: "https://c.test",
        sourcePriority: 5,
        topicScore: 2,
        publishedAt: new Date("2026-08-10T11:30:00.000Z"),
      },
      { ...BASE, canonicalUrl: "https://source-priority.test", sourcePriority: 6 },
    ];

    expect(selectBestCandidate(entries, new Set(), NOW)?.canonicalUrl)
      .toBe("https://source-priority.test");
  });

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

    expect(selectBestCandidate(
      entries,
      new Set([BASE.canonicalUrl]),
      NOW,
    )?.canonicalUrl).toBe(valid.canonicalUrl);
  });
});
