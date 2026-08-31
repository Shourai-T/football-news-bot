import { describe, expect, it } from "vitest";
import type { Article } from "../../supabase/functions/_shared/domain-types";
import { selectEditorialCandidate } from "../../supabase/functions/_shared/ranking";

const NOW = new Date("2026-08-31T12:00:00Z");
function item(sourceName: string, path: string, title: string, publishedAt = NOW): Article {
  return { sourceName, canonicalUrl: `https://news.test/${path}`, title, excerpt: "", publishedAt,
    sourcePriority: sourceName.startsWith("BBC") ? 100 : 80, topicScore: 1 };
}
const BBC = (path: string, title: string, time?: Date) => item("BBC Sport Football", path, title, time);
const SKY = (path: string, title: string, time?: Date) => item("Sky Sports Football", path, title, time);

describe("diverse editorial selection", () => {
  it("uses Sky after two BBC deliveries when an alternative remains within every cap", () => {
    const bbc = BBC("new-bbc", "Harry Kane joins Arsenal");
    const sky = SKY("new-sky", 'Messi says: "I still enjoy playing football every single day"');
    const delivered = [BBC("old-a", "Liverpool training update"), BBC("old-b", "Chelsea injury update")];
    const result = selectEditorialCandidate([bbc, sky], new Set(), NOW, { delivered, selected: [] });
    expect(result?.article.canonicalUrl).toBe(sky.canonicalUrl);
    expect(result).toMatchObject({ diversityFallback: false, excess: 0, sourceId: "sky" });
  });
  it("uses the least repetitive candidate when every choice exceeds a cap", () => {
    const messi = BBC("messi", "Messi joins Arsenal");
    const ronaldo = BBC("ronaldo", "Ronaldo joins Chelsea");
    const delivered = [SKY("a", "Messi joins Arsenal"), BBC("b", "Messi joins Chelsea")];
    const result = selectEditorialCandidate([messi, ronaldo], new Set(), NOW, { delivered, selected: [] });
    expect(result?.article.canonicalUrl).toBe(ronaldo.canonicalUrl);
    expect(result).toMatchObject({ diversityFallback: true, excess: 1 });
  });
  it("applies type caps but does not cap competition names", () => {
    const quote = BBC("quote", 'Ronaldo says: "Football is still my greatest passion every single day"');
    const match = BBC("match", "Arsenal beat Chelsea 2-1 on 2026-08-31");
    const delivered = [SKY("a", 'Messi says: "I still enjoy playing football every single day"'),
      SKY("b", 'Yamal says: "The Champions League is our biggest target this season"')];
    expect(selectEditorialCandidate([quote, match], new Set(), NOW, { delivered, selected: [] })?.article)
      .toBe(match);
    const uclDelivered = [SKY("u1", "Messi joins Arsenal in the UCL"),
      BBC("u2", 'Ronaldo says: "The Champions League remains my biggest target this season"')];
    expect(selectEditorialCandidate([BBC("u3", "Yamal UCL update")], new Set(), NOW,
      { delivered: uclDelivered, selected: [] })?.excess).toBe(0);
  });
  it("counts every entity only once per delivered draft", () => {
    const delivered = [BBC("a", "Messi Messi Arsenal Chelsea transfer update"),
      BBC("b", "Messi Arsenal quote")];
    const candidate = BBC("c", "Messi Arsenal contract news");
    expect(selectEditorialCandidate([candidate], new Set(), NOW, { delivered, selected: [] }))
      .toMatchObject({ diversityFallback: true, excess: 3 });
  });
  it("orders by score, then time, then canonical URL", () => {
    const lower = BBC("lower", "Liverpool training update");
    const higher = SKY("higher", "Harry Kane joins Arsenal");
    expect(selectEditorialCandidate([lower, higher], new Set(), NOW, { delivered: [], selected: [] })?.article).toBe(higher);
    const old = BBC("old", "Liverpool training update", new Date("2026-08-31T11:00:00Z"));
    expect(selectEditorialCandidate([lower, old], new Set(), NOW, { delivered: [], selected: [] })?.article).toBe(lower);
    expect(selectEditorialCandidate([BBC("z", "Liverpool training update"), BBC("a", "Liverpool training update")],
      new Set(), NOW, { delivered: [], selected: [] })?.article.canonicalUrl).toBe("https://news.test/a");
  });
  it("filters unsafe, irrelevant, seen, stale and far-future entries", () => {
    const valid = BBC("valid", "Messi news");
    const entries = [BBC("seen", "Messi news"), { ...BBC("off", "Messi news"), topicScore: 0 },
      BBC("stale", "Messi news", new Date(NOW.getTime() - 72 * 3_600_000 - 1)),
      BBC("future", "Messi news", new Date(NOW.getTime() + 5 * 60_000 + 1)),
      { ...BBC("http", "Messi news"), canonicalUrl: "http://news.test/http" },
      { ...BBC("invalid", "Messi news"), publishedAt: new Date("invalid") }, { ...BBC("blank", "Messi"), title: " " }, valid];
    expect(selectEditorialCandidate(entries, new Set(["https://news.test/seen"]), NOW,
      { delivered: [], selected: [] })?.article).toBe(valid);
  });
  it("accepts hard boundaries and clamps small future freshness", () => {
    const old = BBC("old", "Messi news", new Date(NOW.getTime() - 72 * 3_600_000));
    const future = BBC("future", "Messi news", new Date(NOW.getTime() + 5 * 60_000));
    expect(selectEditorialCandidate([old], new Set(), NOW, { delivered: [], selected: [] })?.score.freshness).toBe(0);
    expect(selectEditorialCandidate([future], new Set(), NOW, { delivered: [], selected: [] })?.score.freshness).toBe(30);
  });
  it("suppresses matching recent events but keeps a later distinct development", () => {
    const selected = BBC("selected", "Harry Kane linked with Arsenal");
    const same = SKY("same", "Harry Kane linked with Arsenal");
    const completed = SKY("completed", "Harry Kane joins Arsenal");
    expect(selectEditorialCandidate([same, completed], new Set(), NOW,
      { delivered: [], selected: [selected] })?.article).toBe(completed);
  });
  it("does not let stale event history suppress a candidate", () => {
    const candidate = SKY("new", "Harry Kane joins Arsenal");
    const selected = BBC("old", "Harry Kane joins Arsenal", new Date(NOW.getTime() - 72 * 3_600_000 - 1));
    expect(selectEditorialCandidate([candidate], new Set(), NOW,
      { delivered: [], selected: [selected] })?.article).toBe(candidate);
  });
  it("returns null without mutating inputs when nothing qualifies", () => {
    const entries = [BBC("off", "Off topic")];
    entries[0]!.topicScore = 0;
    const snapshot = [...entries];
    expect(selectEditorialCandidate(entries, new Set(), NOW, { delivered: [], selected: [] })).toBeNull();
    expect(entries).toEqual(snapshot);
  });
});
