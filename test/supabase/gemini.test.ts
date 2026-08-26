import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDraft } from "../../supabase/functions/_shared/gemini";
import type { Article } from "../../supabase/functions/_shared/domain-types";

const ARTICLE: Article = {
  title: "Club agrees transfer",
  excerpt: "The transfer was confirmed by the club.",
  sourceName: "Official Club",
  canonicalUrl: "https://club.test/news/transfer",
  publishedAt: new Date("2026-08-10T01:00:00.000Z"),
  sourcePriority: 10,
  topicScore: 3,
};
const CONFIG = { apiKey: "gemini-test-secret", model: "gemini-3.5-flash-lite" };
const NOW = new Date("2026-08-10T01:30:00.000Z");

beforeEach(() => {
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
});
afterEach(() => vi.restoreAllMocks());

describe("Supabase Gemini generation", () => {
  it("requests an original, attributed X post with controlled news labels", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        candidates: [{ content: { parts: [{ text: "  Club confirms the transfer.  " }] } }],
      });
    };

    await expect(generateDraft(ARTICLE, CONFIG, fetcher, NOW)).resolves
      .toBe("Club confirms the transfer.");

    const headers = new Headers(calls[0]?.init?.headers);
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: { maxOutputTokens: number };
    };
    const prompt = body.contents[0]!.parts[0]!.text;
    expect(String(calls[0]?.input)).not.toContain(CONFIG.apiKey);
    expect(headers.get("x-goog-api-key")).toBe(CONFIG.apiKey);
    expect(prompt).toContain(ARTICLE.sourceName);
    expect(prompt).toContain(ARTICLE.title);
    expect(prompt).toContain(ARTICLE.excerpt);
    expect(prompt).toContain(ARTICLE.canonicalUrl);
    expect(prompt).toContain("English");
    expect(prompt).toContain("260 characters");
    expect(prompt).toContain(ARTICLE.publishedAt.toISOString());
    expect(prompt).toContain(NOW.toISOString());
    expect(prompt).toContain("🚨 BREAKING:");
    expect(prompt).toContain("✅ OFFICIAL:");
    expect(prompt).toContain("📰 NEWS:");
    expect(prompt).toContain("💬 QUOTE:");
    expect(prompt).toContain("📊 STAT:");
    expect(prompt).toContain("🔥 MATCH:");
    expect(prompt).toContain("Choose exactly one prefix");
    expect(prompt).toContain("Do not use BREAKING unless");
    expect(prompt).toContain("HOOK → KEY FACT → CONTEXT");
    expect(prompt).toContain("Do not copy");
    expect(prompt).toContain("Do not include the canonical URL");
    expect(prompt).toContain(`Via ${ARTICLE.sourceName}`);
    expect(prompt).toContain("Return only the final X post text");
    expect(prompt).not.toContain("Source priority:");
    expect(prompt).not.toContain("Topic score:");
    expect(body.generationConfig.maxOutputTokens).toBe(256);
  });

  it("truncates overlong output to 260 characters", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      candidates: [{ content: { parts: [{ text: "x".repeat(3_500) }] } }],
    });
    await expect(generateDraft(ARTICLE, CONFIG, fetcher)).resolves.toHaveLength(260);
  });

  it("sanitizes empty, timeout, and provider API failures", async () => {
    const empty: typeof fetch = async () => Response.json({
      candidates: [{ content: { parts: [{ text: "   " }] } }],
    });
    await expect(generateDraft(ARTICLE, CONFIG, empty)).rejects
      .toThrow("gemini_empty_response");

    const timeout: typeof fetch = async () => {
      throw new DOMException("provider detail", "TimeoutError");
    };
    await expect(generateDraft(ARTICLE, CONFIG, timeout)).rejects
      .toThrow("gemini_timeout");

    const rateLimited: typeof fetch = async () =>
      new Response("provider payload", { status: 429 });
    await expect(generateDraft(ARTICLE, CONFIG, rateLimited)).rejects
      .toThrow("gemini_api_error:429");
    await expect(generateDraft(ARTICLE, CONFIG, rateLimited)).rejects.not
      .toThrow("provider payload");
  });

  it("uses an exact eight-second timeout", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      candidates: [{ content: { parts: [{ text: "Draft" }] } }],
    });
    await generateDraft(ARTICLE, CONFIG, fetcher);
    expect(vi.mocked(AbortSignal.timeout)).toHaveBeenCalledWith(8_000);
  });
});
