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

beforeEach(() => {
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
});
afterEach(() => vi.restoreAllMocks());

describe("Supabase Gemini generation", () => {
  it("uses only approved source fields and returns a trimmed English draft", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        candidates: [{ content: { parts: [{ text: "  Club confirms the transfer.  " }] } }],
      });
    };

    await expect(generateDraft(ARTICLE, CONFIG, fetcher)).resolves
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
    expect(prompt).toContain("3,000 characters");
    expect(prompt).not.toContain(ARTICLE.publishedAt.toISOString());
    expect(prompt).not.toContain("Source priority:");
    expect(prompt).not.toContain("Topic score:");
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
  });

  it("truncates overlong output to 3,000 characters", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      candidates: [{ content: { parts: [{ text: "x".repeat(3_500) }] } }],
    });
    await expect(generateDraft(ARTICLE, CONFIG, fetcher)).resolves.toHaveLength(3_000);
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
