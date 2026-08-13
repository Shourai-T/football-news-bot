import { describe, expect, it } from "vitest";
import { VERIFIED_FEEDS } from "../../supabase/functions/_shared/feed-config";

describe("verified feed configuration", () => {
  it("uses only the three versioned HTTPS feeds in source-priority order", () => {
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
      {
        name: "Liverpool FC official",
        url: "https://www.liverpoolfc.com/?feed=rss2",
        priority: 70,
      },
    ]);
    expect(VERIFIED_FEEDS.every((feed) => new URL(feed.url).protocol === "https:"))
      .toBe(true);
  });
});
