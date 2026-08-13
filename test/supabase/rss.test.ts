import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeUrl,
  fetchFeedEntries,
} from "../../supabase/functions/_shared/rss";

const NOW = new Date("2026-08-10T12:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

describe("Supabase RSS normalization", () => {
  it("removes tracking parameters while preserving article parameters", () => {
    expect(canonicalizeUrl("https://example.test/a?utm_source=rss&id=9#top"))
      .toBe("https://example.test/a?id=9");
  });

  it("normalizes RSS and Atom entries, drops unsafe links, and keeps the best duplicate", async () => {
    const feeds = [
      { name: "RSS", url: "https://rss.test/feed", priority: 2 },
      { name: "Atom", url: "https://atom.test/feed", priority: 1 },
    ];
    const fetcher: typeof fetch = async (input) => {
      if (input.toString().includes("rss.test")) {
        return new Response(
          `<?xml version="1.0"?><rss><channel><item><title>Messi transfer update</title><link>https://example.test/story?utm_source=rss&amp;id=9#top</link><description>Latest move</description><pubDate>Sun, 10 Aug 2026 11:00:00 GMT</pubDate></item><item><title>Unsafe</title><link>http://example.test/unsafe</link><pubDate>Sun, 10 Aug 2026 11:00:00 GMT</pubDate></item></channel></rss>`,
        );
      }
      return new Response(
        `<?xml version="1.0"?><feed><entry><title>Duplicate</title><link href="https://example.test/story?id=9"/><summary>Duplicate source</summary><updated>2026-08-10T10:00:00Z</updated></entry><entry><title>Premier League update</title><link href="https://example.test/premier-league"/><updated>2026-08-10T09:00:00Z</updated></entry></feed>`,
      );
    };

    await expect(fetchFeedEntries(feeds, fetcher, NOW)).resolves.toEqual([
      {
        title: "Messi transfer update",
        excerpt: "Latest move",
        sourceName: "RSS",
        canonicalUrl: "https://example.test/story?id=9",
        publishedAt: new Date("2026-08-10T11:00:00.000Z"),
        sourcePriority: 2,
        topicScore: 2,
      },
      {
        title: "Premier League update",
        excerpt: "",
        sourceName: "Atom",
        canonicalUrl: "https://example.test/premier-league",
        publishedAt: new Date("2026-08-10T09:00:00.000Z"),
        sourcePriority: 1,
        topicScore: 1,
      },
    ]);
  });

  it("isolates failed and malformed feeds while retaining healthy entries", async () => {
    const failures: string[] = [];
    const feeds = [
      { name: "Failed", url: "https://failed.test/rss", priority: 1 },
      { name: "Malformed", url: "https://malformed.test/rss", priority: 1 },
      { name: "Healthy", url: "https://healthy.test/rss", priority: 1 },
    ];
    const fetcher: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("failed")) throw new Error("provider detail");
      if (url.includes("malformed")) return new Response("<rss><channel>");
      return new Response(
        "<rss><channel><item><title>Ronaldo news</title><link>https://healthy.test/article</link><pubDate>2026-08-10T10:00:00Z</pubDate></item></channel></rss>",
      );
    };

    await expect(fetchFeedEntries(
      feeds,
      fetcher,
      NOW,
      (feedName) => failures.push(feedName),
    )).resolves.toMatchObject([
      { canonicalUrl: "https://healthy.test/article", sourceName: "Healthy" },
    ]);
    expect(failures.sort()).toEqual(["Failed", "Malformed"]);
  });

  it("gives each feed request an exact eight-second timeout", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetcher: typeof fetch = async (_input, init) => {
      expect(init?.signal).toBe(signal);
      return new Response(
        "<rss><channel><item><title>Ronaldo news</title><link>https://source.test/article</link><pubDate>2026-08-10T10:00:00Z</pubDate></item></channel></rss>",
      );
    };

    await fetchFeedEntries(
      [{ name: "Source", url: "https://source.test/rss", priority: 1 }],
      fetcher,
      NOW,
    );

    expect(timeout).toHaveBeenCalledWith(8_000);
  });
});
