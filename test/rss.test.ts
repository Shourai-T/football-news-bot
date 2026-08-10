import { describe, expect, it, vi } from "vitest";
import { parseFeeds } from "../src/config";
import { canonicalizeUrl, fetchFeedEntries } from "../src/rss";

const NOW = new Date("2026-08-10T12:00:00.000Z");

describe("RSS feed configuration", () => {
  it("parses named HTTPS feeds with source priority", () => {
    expect(
      parseFeeds(
        '[{"name":"BBC Sport","url":"https://bbc.test/rss","priority":10}]',
      ),
    ).toEqual([{ name: "BBC Sport", url: "https://bbc.test/rss", priority: 10 }]);
  });

  it("rejects malformed feed configuration", () => {
    expect(() => parseFeeds("not json")).toThrow("RSS_FEEDS_JSON");
  });
});

describe("RSS normalization", () => {
  it("removes a tracking parameter but preserves an article parameter", () => {
    expect(canonicalizeUrl("https://example.test/a?utm_source=rss&id=9"))
      .toBe("https://example.test/a?id=9");
  });

  it("normalizes valid HTTPS RSS and Atom entries and drops duplicate or unsafe links", async () => {
    const feeds = [
      { name: "RSS", url: "https://rss.test/feed", priority: 2 },
      { name: "Atom", url: "https://atom.test/feed", priority: 1 },
    ];
    const fetcher: typeof fetch = async (input) => {
      if (input.toString().includes("rss.test")) {
        return new Response(
          `<?xml version="1.0"?><rss><channel><item><title>Messi transfer update</title><link>https://example.test/story?utm_source=rss&amp;id=9#top</link><description>Latest move</description><pubDate>Sun, 10 Aug 2026 11:00:00 GMT</pubDate></item><item><title>Unsafe</title><link>http://example.test/unsafe</link><pubDate>Sun, 10 Aug 2026 11:00:00 GMT</pubDate></item></channel></rss>`,
          { status: 200 },
        );
      }
      return new Response(
        `<?xml version="1.0"?><feed><entry><title>Duplicate</title><link href="https://example.test/story?id=9"/><summary>Duplicate source</summary><updated>2026-08-10T10:00:00Z</updated></entry><entry><title>Premier League update</title><link href="https://example.test/premier-league"/><updated>2026-08-10T09:00:00Z</updated></entry></feed>`,
        { status: 200 },
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

  it("retains higher-priority metadata when a later feed repeats a canonical URL", async () => {
    const feeds = [
      { name: "Low priority", url: "https://low.test/rss", priority: 1 },
      { name: "High priority", url: "https://high.test/rss", priority: 10 },
    ];
    const fetcher: typeof fetch = async (input) => {
      const highPriority = input.toString().includes("high.test");
      return new Response(
        `<rss><channel><item><title>${highPriority ? "Ronaldo transfer" : "Ronaldo update"}</title><link>https://example.test/story?utm_source=rss&amp;id=9</link><description>Latest football news</description><pubDate>${highPriority ? "2026-08-10T11:00:00Z" : "2026-08-10T10:00:00Z"}</pubDate></item></channel></rss>`,
        { status: 200 },
      );
    };

    await expect(fetchFeedEntries(feeds, fetcher, NOW)).resolves.toMatchObject([
      {
        canonicalUrl: "https://example.test/story?id=9",
        sourceName: "High priority",
        sourcePriority: 10,
      },
    ]);
  });

  it("returns entries from healthy feeds when another feed fails or returns malformed XML", async () => {
    const feeds = [
      { name: "Failed", url: "https://failed.test/rss", priority: 1 },
      { name: "Malformed", url: "https://malformed.test/rss", priority: 1 },
      { name: "Healthy", url: "https://healthy.test/rss", priority: 1 },
    ];
    const fetcher: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("failed")) throw new Error("network unavailable");
      if (url.includes("malformed")) return new Response("<rss><channel>", { status: 200 });
      return new Response(
        "<rss><channel><item><title>Ronaldo news</title><link>https://healthy.test/article</link><pubDate>2026-08-10T10:00:00Z</pubDate></item></channel></rss>",
        { status: 200 },
      );
    };

    await expect(fetchFeedEntries(feeds, fetcher, NOW)).resolves.toMatchObject([
      { canonicalUrl: "https://healthy.test/article", sourceName: "Healthy" },
    ]);
  });

  it("gives every feed request an eight-second abort signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const signal = new AbortController().signal;
    timeout.mockReturnValue(signal);
    const fetcher: typeof fetch = async (_input, init) => {
      expect(init?.signal).toBe(signal);
      return new Response("<rss><channel><item><title>Ronaldo news</title><link>https://source.test/article</link><pubDate>2026-08-10T10:00:00Z</pubDate></item></channel></rss>");
    };

    await fetchFeedEntries(
      [{ name: "Source", url: "https://source.test/rss", priority: 1 }],
      fetcher,
      NOW,
    );

    expect(timeout).toHaveBeenCalledWith(8_000);
    timeout.mockRestore();
  });
});
