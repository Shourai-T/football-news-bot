import { describe, expect, it } from "vitest";
import { VERIFIED_FEEDS } from "../../supabase/functions/_shared/feed-config";

describe("verified feed configuration", () => {
  it("fetches only the enabled BBC and Sky endpoints", () => {
    expect(VERIFIED_FEEDS).toEqual([
      {
        name: "BBC Sport Football",
        url: "https://feeds.bbci.co.uk/sport/football/rss.xml",
        priority: 100,
      },
      {
        name: "Sky Sports Football",
        url: "https://www.skysports.com/rss/12040",
        priority: 80,
      },
    ]);
    expect(VERIFIED_FEEDS.every((feed) => new URL(feed.url).protocol === "https:"))
      .toBe(true);
  });
});
