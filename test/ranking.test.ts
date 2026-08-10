import { describe, expect, it } from "vitest";
import { selectBestCandidate } from "../src/ranking";
import type { Article } from "../src/types";

const NOW = new Date("2026-08-10T12:00:00.000Z");

const entries: Article[] = [
  {
    title: "Transfer target",
    excerpt: "",
    sourceName: "BBC",
    canonicalUrl: "https://bbc.test/transfer",
    publishedAt: new Date("2026-08-10T11:00:00.000Z"),
    sourcePriority: 10,
    topicScore: 1,
  },
  {
    title: "Messi update",
    excerpt: "",
    sourceName: "Lower priority",
    canonicalUrl: "https://lower.test/messi",
    publishedAt: new Date("2026-08-10T11:30:00.000Z"),
    sourcePriority: 1,
    topicScore: 2,
  },
];

describe("candidate ranking", () => {
  it("selects a fresh eligible higher-priority transfer article", () => {
    expect(selectBestCandidate(entries, new Set(), NOW)?.canonicalUrl)
      .toBe("https://bbc.test/transfer");
  });

  it("rejects seen, stale, and off-topic articles", () => {
    const candidates: Article[] = [
      ...entries,
      {
        ...entries[0],
        canonicalUrl: "https://bbc.test/stale",
        publishedAt: new Date("2026-08-07T11:59:59.999Z"),
        sourcePriority: 100,
      },
      {
        ...entries[0],
        canonicalUrl: "https://bbc.test/off-topic",
        sourcePriority: 100,
        topicScore: 0,
      },
    ];

    expect(
      selectBestCandidate(candidates, new Set(["https://bbc.test/transfer"]), NOW)
        ?.canonicalUrl,
    ).toBe("https://lower.test/messi");
  });

  it("uses topic score and then publication time to break source-priority ties", () => {
    const candidates: Article[] = [
      { ...entries[0], canonicalUrl: "https://a.test", sourcePriority: 5, topicScore: 1 },
      { ...entries[0], canonicalUrl: "https://b.test", sourcePriority: 5, topicScore: 2, publishedAt: new Date("2026-08-10T10:00:00.000Z") },
      { ...entries[0], canonicalUrl: "https://c.test", sourcePriority: 5, topicScore: 2, publishedAt: new Date("2026-08-10T11:30:00.000Z") },
    ];

    expect(selectBestCandidate(candidates, new Set(), NOW)?.canonicalUrl).toBe("https://c.test");
  });
});
