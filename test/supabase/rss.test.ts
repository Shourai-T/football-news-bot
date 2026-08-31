import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeUrl,
  fetchFeedEntries,
  type FeedDiagnostic,
} from "../../supabase/functions/_shared/rss";
import { VERIFIED_FEEDS } from "../../supabase/functions/_shared/feed-config";

const NOW = new Date("2026-08-10T12:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

describe("Supabase RSS normalization", () => {
  it("keeps Sky articles with BST dates and reports rejected sibling dates", async () => {
    const diagnostics: FeedDiagnostic[] = [];
    const xml = `<rss><channel><item><title>Harry Kane joins Arsenal</title><link>https://www.skysports.com/football/news/a</link><pubDate>Mon, 31 Aug 2026 09:54:00 BST</pubDate></item><item><title>Messi news</title><link>https://www.skysports.com/football/news/b</link><pubDate>broken</pubDate></item></channel></rss>`;
    const result = await fetchFeedEntries([VERIFIED_FEEDS[1]!], async () => new Response(xml), NOW,
      undefined, (diagnostic) => diagnostics.push(diagnostic));
    expect(result).toHaveLength(1);
    expect(result[0]?.publishedAt.toISOString()).toBe("2026-08-31T08:54:00.000Z");
    expect(diagnostics).toEqual([{
      sourceId: "sky", outcome: "ok", category: "none", items: 2, usable: 1,
      invalidDate: 1, invalidUrl: 0, invalidContent: 0,
    }]);
  });

  it.each([
    ["<html><body>Landing page</body></html>", "failed", "unsupported_structure"],
    ["<anything/>", "failed", "unsupported_structure"],
    ["<rss><channel>", "failed", "invalid_xml"],
    ["<feed/>", "empty", "none"],
    ["<rss><channel/></rss>", "empty", "none"],
    ["<rss><channel><item><title>Messi news</title><link>https://example.test/a</link><pubDate>broken</pubDate></item></channel></rss>", "failed", "all_items_invalid"],
  ])("distinguishes feed structure for %s", async (xml, outcome, category) => {
    const diagnostics: FeedDiagnostic[] = [];
    const failures: string[] = [];
    const result = await fetchFeedEntries([VERIFIED_FEEDS[0]!], async () => new Response(xml), NOW,
      (name) => failures.push(name), (diagnostic) => diagnostics.push(diagnostic));
    expect(result).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome, category });
    expect(failures).toHaveLength(outcome === "failed" ? 1 : 0);
  });

  it.each(["network", "timeout", "http"])("redacts %s transport failures", async (category) => {
    const diagnostics: FeedDiagnostic[] = [];
    await fetchFeedEntries([VERIFIED_FEEDS[0]!], async () => {
      if (category === "http") return new Response("PRIVATE_BODY", { status: 503 });
      if (category === "timeout") throw new DOMException("PRIVATE_EXCEPTION", "TimeoutError");
      throw new Error("PRIVATE_EXCEPTION");
    }, NOW, undefined, (diagnostic) => diagnostics.push(diagnostic));
    expect(diagnostics[0]).toMatchObject({ outcome: "failed", category });
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE");
  });

  it("does not lose usable entries if a diagnostic observer throws", async () => {
    const result = await fetchFeedEntries([VERIFIED_FEEDS[0]!], async () => new Response(
      "<rss><channel><item><title>Messi news</title><link>https://example.test/a</link><pubDate>2026-08-31T10:00:00Z</pubDate></item></channel></rss>"),
      NOW, undefined, () => { throw new Error("observer failure"); });
    expect(result).toHaveLength(1);
  });

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
