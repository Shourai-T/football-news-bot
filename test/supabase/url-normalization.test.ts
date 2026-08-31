import { describe, expect, it } from "vitest";
import { bbcArticleBase, canonicalizeUrl, escapeLikeLiteral } from "../../supabase/functions/_shared/url-normalization";

describe("article URL identity", () => {
  it("removes BBC tracking while preserving article parameters", () => {
    expect(canonicalizeUrl("https://www.bbc.co.uk/sport/a?at_medium=RSS&at_campaign=rss&id=9#top"))
      .toBe("https://www.bbc.co.uk/sport/a?id=9");
    expect(canonicalizeUrl("https://www.bbc.com/sport/a?at_medium=RSS&utm_source=x&fbclid=9&gclid=2"))
      .toBe("https://www.bbc.com/sport/a");
  });
  it.each(["https://bbc.co.uk.evil.test/sport/a", "https://other.test/sport/a", "https://www.bbc.co.uk/news/a"])(
    "preserves non-football/BBC parameters on %s", (base) => {
      expect(canonicalizeUrl(`${base}?at_medium=RSS&id=9`)).toBe(`${base}?at_medium=RSS&id=9`);
      expect(bbcArticleBase(base)).toBeNull();
    },
  );
  it("uses the exact BBC path for legacy lookups", () => {
    expect(bbcArticleBase("https://www.bbc.co.uk/sport/a?at_medium=RSS"))
      .toBe("https://www.bbc.co.uk/sport/a");
    expect(escapeLikeLiteral("/a_b%\\c")).toBe("/a\\_b\\%\\\\c");
  });
});
