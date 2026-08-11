import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledPipeline } from "../src/pipeline";
import { recordArticle } from "../src/repository";
import type { Article, Env } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const SCHEDULED_TIME = Date.parse("2026-08-10T01:07:00.000Z");
const SLOT_KEY = "2026-08-10T01:07Z";
const CHAT_ID = "-100123";

const seenArticle: Article = {
  title: "Ronaldo transfer update",
  excerpt: "The club confirmed the transfer update.",
  sourceName: "Official feed",
  canonicalUrl: "https://club.test/news/transfer",
  publishedAt: new Date("2026-08-10T00:30:00.000Z"),
  sourcePriority: 10,
  topicScore: 2,
};

function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    TELEGRAM_BOT_TOKEN: "telegram-test-token",
    TELEGRAM_CHAT_ID: CHAT_ID,
    TELEGRAM_WEBHOOK_SECRET: "webhook-test-secret",
    DIAGNOSTIC_SECRET: "diagnostic-test-secret",
    GEMINI_API_KEY: "gemini-test-key",
    GEMINI_MODEL: "gemini-test-model",
    RSS_FEEDS_JSON: JSON.stringify([
      { name: "Official feed", url: "https://club.test/rss", priority: 10 },
    ]),
    ...overrides,
  };
}

function rssDocument(url: string): string {
  return `<rss><channel><item><title>Ronaldo transfer update</title><link>${url}</link><description>The club confirmed the transfer update.</description><pubDate>2026-08-10T00:30:00Z</pubDate></item></channel></rss>`;
}

describe("scheduled pipeline", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM drafts"),
      env.DB.prepare("DELETE FROM articles"),
      env.DB.prepare("DELETE FROM scheduled_runs"),
      env.DB.prepare("DELETE FROM daily_usage"),
    ]);
  });

  it("records no_candidate without calling Gemini when all entries are seen", async () => {
    await recordArticle(env.DB, seenArticle, true);
    const requestedUrls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(rssDocument(seenArticle.canonicalUrl));
    };

    await runScheduledPipeline(workerEnv(), SCHEDULED_TIME, fetcher);

    expect(requestedUrls.filter((url) => url.includes("generativelanguage.googleapis.com"))).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT outcome FROM scheduled_runs WHERE slot_key = ?")
        .bind(SLOT_KEY)
        .first<string>("outcome"),
    ).toBe("no_candidate");
  });

  it("begins a run before RSS fetch and skips an existing slot", async () => {
    let rssRequests = 0;
    const fetcher: typeof fetch = async () => {
      rssRequests += 1;
      return new Response("<rss><channel></channel></rss>");
    };

    await runScheduledPipeline(workerEnv(), SCHEDULED_TIME, fetcher);
    await runScheduledPipeline(workerEnv(), SCHEDULED_TIME, fetcher);

    expect(rssRequests).toBe(1);
  });

  it("does not redraft a canonical URL in a later slot", async () => {
    const requestedUrls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("club.test/rss")) return new Response(rssDocument(seenArticle.canonicalUrl));
      if (url.includes("generativelanguage.googleapis.com")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: "A factual draft." }] } }] });
      }
      return Response.json({ ok: true, result: { message_id: 314 } });
    };

    await runScheduledPipeline(workerEnv(), SCHEDULED_TIME, fetcher);
    await runScheduledPipeline(workerEnv(), Date.parse("2026-08-10T04:07:00.000Z"), fetcher);

    expect(requestedUrls.filter((url) => url.includes("generativelanguage.googleapis.com"))).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM drafts").first<number>("total")).toBe(1);
  });

  it("blocks a sixth Gemini request in the same Vietnam date", async () => {
    let rssRequests = 0;
    const requestedUrls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("club.test/rss")) {
        rssRequests += 1;
        return new Response(rssDocument(`https://club.test/news/transfer-${rssRequests}`));
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: "A factual draft." }] } }] });
      }
      return Response.json({ ok: true, result: { message_id: 300 + rssRequests } });
    };

    for (let index = 0; index < 6; index += 1) {
      await runScheduledPipeline(workerEnv(), SCHEDULED_TIME + index * 60 * 60 * 1000, fetcher);
    }

    expect(requestedUrls.filter((url) => url.includes("generativelanguage.googleapis.com"))).toHaveLength(5);
    expect(
      await env.DB.prepare("SELECT gemini_requests FROM daily_usage WHERE local_date = ?")
        .bind("2026-08-10")
        .first<number>("gemini_requests"),
    ).toBe(5);
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM drafts").first<number>("total")).toBe(5);
  });

  it("uses the Vietnam calendar date for quota accounting", async () => {
    const afterVietnamMidnight = Date.parse("2026-08-10T17:07:00.000Z");
    const fetcher: typeof fetch = async () => new Response("<rss><channel></channel></rss>");

    await runScheduledPipeline(workerEnv(), afterVietnamMidnight, fetcher);

    expect(
      await env.DB.prepare("SELECT local_date FROM scheduled_runs WHERE slot_key = ?")
        .bind("2026-08-10T17:07Z")
        .first<string>("local_date"),
    ).toBe("2026-08-11");
  });

  it("starts a separate five-request Gemini quota after Vietnam midnight", async () => {
    let rssRequests = 0;
    const requestedUrls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("club.test/rss")) {
        rssRequests += 1;
        return new Response(rssDocument(`https://club.test/news/midnight-${rssRequests}`));
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: "A factual draft." }] } }] });
      }
      return Response.json({ ok: true, result: { message_id: 400 + rssRequests } });
    };

    for (let index = 0; index < 5; index += 1) {
      await runScheduledPipeline(workerEnv(), Date.parse("2026-08-10T12:00:00.000Z") + index * 60_000, fetcher);
    }
    await runScheduledPipeline(workerEnv(), Date.parse("2026-08-10T17:07:00.000Z"), fetcher);

    expect(requestedUrls.filter((url) => url.includes("generativelanguage.googleapis.com"))).toHaveLength(6);
    expect(await env.DB.prepare("SELECT gemini_requests FROM daily_usage WHERE local_date = ?").bind("2026-08-10").first<number>("gemini_requests")).toBe(5);
    expect(await env.DB.prepare("SELECT gemini_requests FROM daily_usage WHERE local_date = ?").bind("2026-08-11").first<number>("gemini_requests")).toBe(1);
  });

  it("marks a run failed without creating a draft when Gemini fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("club.test/rss")) return new Response(rssDocument(seenArticle.canonicalUrl));
      return new Response("provider error", { status: 500 });
    };

    await runScheduledPipeline(workerEnv(), SCHEDULED_TIME, fetcher);

    expect(await env.DB.prepare("SELECT outcome, error_summary FROM scheduled_runs WHERE slot_key = ?").bind(SLOT_KEY).first())
      .toMatchObject({ outcome: "failed", error_summary: "gemini_api_error" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM drafts").first<number>("total")).toBe(0);
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "scheduled_run_failed",
      slotKey: SLOT_KEY,
      category: "gemini_api_error",
    }));
  });

  it("marks a created draft failed when Telegram send fails", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("club.test/rss")) return new Response(rssDocument(seenArticle.canonicalUrl));
      if (url.includes("generativelanguage.googleapis.com")) return Response.json({ candidates: [{ content: { parts: [{ text: "A factual draft." }] } }] });
      return new Response("provider error", { status: 500 });
    };

    await runScheduledPipeline(workerEnv(), SCHEDULED_TIME, fetcher);

    expect(await env.DB.prepare("SELECT outcome, error_summary FROM scheduled_runs WHERE slot_key = ?").bind(SLOT_KEY).first())
      .toMatchObject({ outcome: "failed", error_summary: "telegram_api_error" });
    expect(await env.DB.prepare("SELECT status FROM drafts").first<string>("status")).toBe("failed");
  });

  it("records a total RSS outage as failed and logs only a short category", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher: typeof fetch = async () => {
      throw new Error("upstream details must not be logged");
    };

    await runScheduledPipeline(workerEnv(), SCHEDULED_TIME, fetcher);

    expect(
      await env.DB.prepare("SELECT outcome, error_summary FROM scheduled_runs WHERE slot_key = ?")
        .bind(SLOT_KEY)
        .first(),
    ).toMatchObject({ outcome: "failed", error_summary: "rss_unavailable" });
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "rss_feed_error", slotKey: SLOT_KEY, sourceCount: 1,
    }));
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("upstream details"));
  });

  it("logs a partial RSS failure and still processes a healthy feed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("failed.test")) throw new Error("private upstream details");
      if (url.includes("healthy.test")) return new Response(rssDocument(seenArticle.canonicalUrl));
      if (url.includes("generativelanguage.googleapis.com")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: "A factual draft." }] } }] });
      }
      return Response.json({ ok: true, result: { message_id: 314 } });
    };

    await runScheduledPipeline(
      workerEnv({
        RSS_FEEDS_JSON: JSON.stringify([
          { name: "Failed", url: "https://failed.test/rss", priority: 20 },
          { name: "Healthy", url: "https://healthy.test/rss", priority: 10 },
        ]),
      }),
      SCHEDULED_TIME,
      fetcher,
    );

    expect(
      await env.DB.prepare("SELECT outcome FROM scheduled_runs WHERE slot_key = ?")
        .bind(SLOT_KEY)
        .first<string>("outcome"),
    ).toBe("draft_sent");
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "rss_feed_error", slotKey: SLOT_KEY, sourceCount: 2,
    }));
  });

  it("categorizes a D1 failure while beginning a run", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingDb = {
      prepare(): never {
        throw new Error("database connection details");
      },
    } as unknown as D1Database;

    await expect(
      runScheduledPipeline(workerEnv({ DB: failingDb }), SCHEDULED_TIME, async () => {
        throw new Error("fetch must not be called");
      }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "scheduled_run_failed", slotKey: SLOT_KEY, category: "pipeline_error",
    }));
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("connection details"));
  });

  it("preserves the primary category when failed-run cleanup also fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cleanupFailingDb = {
      prepare(query: string): D1PreparedStatement {
        if (query.startsWith("UPDATE scheduled_runs SET outcome")) {
          throw new Error("cleanup database details");
        }
        return env.DB.prepare(query);
      },
    } as unknown as D1Database;

    await runScheduledPipeline(
      workerEnv({ DB: cleanupFailingDb, RSS_FEEDS_JSON: "not json" }),
      SCHEDULED_TIME,
      async () => {
        throw new Error("fetch must not be called");
      },
    );

    expect(consoleError.mock.calls).toEqual([
      [JSON.stringify({ event: "scheduled_run_failed", slotKey: SLOT_KEY, category: "config_error" })],
      [JSON.stringify({ event: "scheduled_run_cleanup_failed", slotKey: SLOT_KEY })],
    ]);
  });
});
