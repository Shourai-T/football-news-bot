import { describe, expect, it } from "vitest";
import type { Article } from "../../supabase/functions/_shared/domain-types";
import type { SourcePolicy } from "../../supabase/functions/_shared/feed-config";
import { analyzeArticle, normalizeWords, scoreArticle } from "../../supabase/functions/_shared/editorial";

const NOW = new Date("2026-08-31T12:00:00Z");
const BASE: Article = { title: "Harry Kane joins Arsenal", excerpt: "", sourceName: "BBC Sport Football",
  canonicalUrl: "https://www.bbc.co.uk/sport/football/articles/a", publishedAt: NOW, sourcePriority: 100, topicScore: 2 };
const OFFICIAL: SourcePolicy = { id: "test-club", name: "Test Club", kind: "official", credibility: 15,
  datePolicy: "standard", articleHosts: ["club.test"], directAnnouncementPaths: ["/news/announcements/"] };

describe("editorial analysis", () => {
  it("normalizes accents and collapses repeated whole-phrase aliases", () => {
    const item = analyzeArticle({ ...BASE,
      title: "Man Utd Manchester United PSG Mbappé Mbappe UCL Champions League" });
    expect(item.features.entities).toEqual(["club:manchester-united", "club:paris-saint-germain", "player:mbappe"]);
    expect(item.features.competitions).toEqual(["competition:champions-league"]);
    expect(normalizeWords("  Vinícius — Atlético! ")).toBe("vinicius atletico");
  });
  it("does not infer clubs from generic United or City", () => {
    expect(analyzeArticle({ ...BASE, title: "City United Messiha Messi" }).features.entities).toEqual(["player:messi"]);
  });
  it.each([
    ["Harry Kane joins Arsenal", "transfer", true],
    ["Harry Kane agrees to join Arsenal", "transfer", true],
    ["Harry Kane linked with Arsenal", "transfer", false],
    ["Harry Kane extends contract until 2029", "contract", true],
    ["Ronaldo suffers injury on 2026-08-31", "injury", true],
    ["Arsenal beat Chelsea 2-1 on 2026-08-31", "match", true],
    ['Messi says: "I still enjoy playing football every single day"', "quote", false],
    ["Messi reaches 900 career goals", "stat", false],
    ["Liverpool training update", "general", false],
  ] as const)("classifies %s", (title, type, explicitDevelopment) => {
    expect(analyzeArticle({ ...BASE, title }).features).toMatchObject({ type, explicitDevelopment });
  });
  it("scores the independent event, subject, freshness and source components", () => {
    expect(scoreArticle(analyzeArticle(BASE), NOW)).toEqual({ event: 20, subjects: 15, freshness: 30, source: 15, total: 80 });
    expect(scoreArticle(analyzeArticle({ ...BASE, publishedAt: new Date("2026-08-30T00:00:00Z") }), NOW).freshness).toBe(15);
    expect(scoreArticle(analyzeArticle({ ...BASE, publishedAt: new Date("2026-08-28T12:00:00Z") }), NOW).freshness).toBe(0);
    expect(scoreArticle(analyzeArticle({ ...BASE, publishedAt: new Date("2026-08-31T12:01:00Z") }), NOW).freshness).toBe(30);
  });
  it("never upgrades a publisher because its headline says OFFICIAL or BREAKING", () => {
    const item = analyzeArticle({ ...BASE, title: "OFFICIAL BREAKING: Harry Kane joins Arsenal", excerpt: "The club confirms the signing" });
    expect(item.features.directOfficial).toBe(false);
    expect(scoreArticle(item, NOW).event).toBe(20);
  });
  it("requires a trusted host/path and first-party confirmation", () => {
    const item = analyzeArticle({ ...BASE, sourceName: "Test Club", canonicalUrl: "https://club.test/news/announcements/kane",
      excerpt: "The club confirms Harry Kane joins Arsenal" }, OFFICIAL);
    expect(item.features.directOfficial).toBe(true);
    expect(scoreArticle(item, NOW)).toEqual({ event: 30, subjects: 15, freshness: 30, source: 20, total: 95 });
  });
  it.each(["According to reports", "Reportedly", "Rumour", "Rumor", "linked with", "The club does not confirm", "The club denies reports"])(
    "does not treat %s as direct confirmation", (prefix) => {
      expect(analyzeArticle({ ...BASE, sourceName: "Test Club", canonicalUrl: "https://club.test/news/announcements/kane",
        excerpt: `${prefix}. The club confirms Harry Kane joins Arsenal` }, OFFICIAL).features.directOfficial).toBe(false);
    },
  );
  it.each(["https://club.test/news/media-watch/kane", "https://evil.test/news/announcements/kane", "http://club.test/news/announcements/kane"])(
    "rejects official privilege for %s", (canonicalUrl) => {
      expect(analyzeArticle({ ...BASE, canonicalUrl, excerpt: "The club confirms the signing" }, OFFICIAL).features.directOfficial).toBe(false);
    },
  );
  it("uses zero credibility for unknown sources and caps repeated subject categories", () => {
    const item = analyzeArticle({ ...BASE, sourceName: "Unknown", title: "Messi Ronaldo Messi Arsenal Chelsea UCL EPL" });
    expect(scoreArticle(item, NOW)).toMatchObject({ subjects: 20, source: 0 });
  });
});
