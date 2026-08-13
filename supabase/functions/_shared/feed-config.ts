import type { FeedDefinition } from "./domain-types.ts";

export const VERIFIED_FEEDS: readonly FeedDefinition[] = [
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
];
