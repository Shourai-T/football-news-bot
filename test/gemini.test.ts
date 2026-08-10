import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDraft } from "../src/gemini";
import type { Article } from "../src/types";

const article: Article = {
  title: "Club agrees transfer",
  excerpt: "The transfer was confirmed by the club.",
  sourceName: "Official Club",
  canonicalUrl: "https://club.test/news/transfer",
  publishedAt: new Date("2026-08-10T01:00:00.000Z"),
  sourcePriority: 10,
  topicScore: 3,
};

const config = {
  apiKey: "gemini-test-secret",
  model: "gemini-2.5-flash",
};

beforeEach(() => {
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateDraft", () => {
  it("returns a trimmed non-empty candidate from a source-only factual prompt", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        candidates: [{ content: { parts: [{ text: "  Club confirms the transfer.  " }] } }],
      });
    };

    await expect(generateDraft(article, config, fetcher)).resolves.toBe("Club confirms the transfer.");

    const requestUrl = String(calls[0]?.input);
    const headers = new Headers(calls[0]?.init?.headers);
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const prompt = body.contents[0]!.parts[0]!.text;
    expect(requestUrl).not.toContain(config.apiKey);
    expect(headers.get("x-goog-api-key")).toBe(config.apiKey);
    expect(prompt).toContain(article.sourceName);
    expect(prompt).toContain(article.title);
    expect(prompt).toContain(article.excerpt);
    expect(prompt).toContain(article.canonicalUrl);
    expect(prompt).toContain("Do not invent");
    expect(prompt).toContain("English");
    expect(prompt).toContain("3,000 characters");
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 1024 } });
    expect(prompt).not.toContain(article.publishedAt.toISOString());
    expect(prompt).not.toContain("Source priority:");
    expect(prompt).not.toContain("Topic score:");
  });

  it("bounds an overlong Gemini candidate before it reaches Telegram", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ candidates: [{ content: { parts: [{ text: "x".repeat(3_500) }] } }] });

    await expect(generateDraft(article, config, fetcher)).resolves.toHaveLength(3_000);
  });

  it("rejects an empty Gemini candidate", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ candidates: [{ content: { parts: [{ text: "   " }] } }] });

    await expect(generateDraft(article, config, fetcher)).rejects.toThrow("gemini_empty_response");
  });

  it("classifies a timeout while reading the response body", async () => {
    const response = Response.json({});
    vi.spyOn(response, "json").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const fetcher: typeof fetch = async () => response;

    await expect(generateDraft(article, config, fetcher)).rejects.toThrow("gemini_timeout");
  });

  it("maps Gemini API errors without exposing the provider body or secret", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher: typeof fetch = async () =>
      new Response("provider payload must stay private", { status: 429 });

    await expect(generateDraft(article, config, fetcher)).rejects.toThrow("gemini_api_error:429");
    await expect(generateDraft(article, config, fetcher)).rejects.not.toThrow(
      "provider payload must stay private",
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("uses an exact eight-second timeout", async () => {
    const timeout = vi.mocked(AbortSignal.timeout);
    const fetcher: typeof fetch = async () =>
      Response.json({ candidates: [{ content: { parts: [{ text: "Draft" }] } }] });

    await generateDraft(article, config, fetcher);

    expect(timeout).toHaveBeenCalledWith(8_000);
  });
});
