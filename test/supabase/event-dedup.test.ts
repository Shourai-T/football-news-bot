import { describe, expect, it } from "vitest";
import type { Article } from "../../supabase/functions/_shared/domain-types";
import { analyzeArticle } from "../../supabase/functions/_shared/editorial";
import { groupCurrentEvents, sameEvent } from "../../supabase/functions/_shared/event-dedup";

const NOW = new Date("2026-08-31T12:00:00Z");
function story(title: string, path: string, excerpt = "") {
  const article: Article = { title, excerpt, sourceName: "BBC Sport Football",
    canonicalUrl: `https://news.test/${path}`, publishedAt: NOW, sourcePriority: 100, topicScore: 2 };
  return analyzeArticle(article);
}

describe("conservative event identity", () => {
  it.each([
    "Harry Kane joins Arsenal", "Harry Kane linked with Arsenal",
    "Harry Kane extends contract until 2029", "Ronaldo suffers injury on 2026-08-31",
    "Arsenal beat Chelsea 2-1 on 2026-08-31",
    'Messi says: "I still enjoy playing football every single day"',
    "Messi reaches 900 career goals",
  ])("recognizes an evidence-complete event: %s", (title) => {
    const a = story(title, "a"), b = story(title, "b");
    expect(a.features.event).not.toBeNull();
    expect(sameEvent(a, b)).toBe(true);
    expect(groupCurrentEvents([b, a], NOW).map((item) => item.article.canonicalUrl)).toEqual(["https://news.test/a"]);
  });
  it.each([
    ["Harry Kane joins Arsenal", "Harry Kane joins Chelsea"],
    ["Harry Kane linked with Arsenal", "Harry Kane joins Arsenal"],
    ["Harry Kane extends contract until 2029", "Harry Kane terminates contract until 2029"],
    ["Ronaldo suffers injury on 2026-08-31", "Ronaldo returns from injury on 2026-08-31"],
    ["Arsenal beat Chelsea 2-1 on 2026-08-31", "Arsenal beat Chelsea 1-2 on 2026-08-31"],
    ["Arsenal beat Chelsea 2-1 on 2026-08-31", "Arsenal beat Chelsea 2-1 on 2026-08-30"],
    ["Messi reaches 900 career goals", "Messi reaches 901 career goals"],
    ["Ronaldo suffers injury", "Ronaldo discusses retirement"],
    ["Liverpool training update", "Liverpool training update"],
    ["Harry Kane extends contract", "Harry Kane extends contract"],
  ])("keeps distinct or incomplete stories: %s / %s", (a, b) => {
    expect(sameEvent(story(a, "a"), story(b, "b"))).toBe(false);
  });
  it("does not hide numeric conflicts in excerpts", () => {
    expect(sameEvent(story("Harry Kane joins Arsenal", "a", "Fee €50m"),
      story("Harry Kane joins Arsenal", "b", "Fee €60m"))).toBe(false);
  });
  it("keeps exact URL deduplication even without semantic features", () => {
    expect(sameEvent(story("Liverpool training update", "same"), story("Other title", "same"))).toBe(true);
  });
  it("prefers a direct official representative only within a matching event", () => {
    const publisher = story("Harry Kane joins Arsenal", "a");
    const official = story("Harry Kane joins Arsenal", "z");
    official.features.directOfficial = true;
    const other = story("Messi reaches 900 career goals", "other");
    expect(groupCurrentEvents([publisher, other, official], NOW).map((item) => item.article.canonicalUrl))
      .toEqual(["https://news.test/z", "https://news.test/other"]);
  });
  it("requires every group member to agree rather than chaining similarities", () => {
    const a = story("Harry Kane joins Arsenal", "a");
    const b = story("Harry Kane joins Arsenal", "b");
    const c = story("Harry Kane joins Arsenal", "c");
    a.features.titleTokens = ["a", "b", "c", "d"];
    b.features.titleTokens = ["a", "b", "c", "d", "e"];
    c.features.titleTokens = ["b", "c", "d", "e"];
    expect(sameEvent(a, b)).toBe(true);
    expect(sameEvent(b, c)).toBe(true);
    expect(sameEvent(a, c)).toBe(false);
    expect(groupCurrentEvents([c, b, a], NOW).map((item) => item.article.canonicalUrl))
      .toEqual(["https://news.test/a", "https://news.test/c"]);
  });
});
