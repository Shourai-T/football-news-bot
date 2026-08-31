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
];

export interface SourcePolicy {
  id: string;
  name: string;
  kind: "publisher" | "official";
  credibility: number;
  datePolicy: "standard" | "sky-uk";
  articleHosts: readonly string[];
  directAnnouncementPaths: readonly string[];
}

const SOURCES: readonly SourcePolicy[] = [
  { id: "bbc", name: "BBC Sport Football", kind: "publisher", credibility: 15,
    datePolicy: "standard", articleHosts: ["bbc.co.uk", "www.bbc.co.uk", "bbc.com", "www.bbc.com"], directAnnouncementPaths: [] },
  { id: "sky", name: "Sky Sports Football", kind: "publisher", credibility: 15,
    datePolicy: "sky-uk", articleHosts: ["www.skysports.com", "skysports.com"], directAnnouncementPaths: [] },
  // Historical identity only. Its old endpoint is not an enabled feed.
  { id: "liverpool", name: "Liverpool FC official", kind: "official", credibility: 15,
    datePolicy: "standard", articleHosts: ["www.liverpoolfc.com", "liverpoolfc.com"], directAnnouncementPaths: [] },
];
const UNKNOWN_SOURCE: SourcePolicy = {
  id: "unverified", name: "Unverified", kind: "publisher", credibility: 0,
  datePolicy: "standard", articleHosts: [], directAnnouncementPaths: [],
};

export function resolveSource(name: string): SourcePolicy {
  return SOURCES.find((source) => source.name === name) ?? UNKNOWN_SOURCE;
}
