import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  beginRun,
  completeRun,
  createDraft,
  getSeenUrls,
  recordArticle,
  reserveGeminiRequest,
  setDraftTelegramMessage,
  transitionDraft,
} from "../src/repository";
import type { Article } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const article: Article = {
  title: "Club agrees transfer",
  excerpt: "The transfer was confirmed by the club.",
  sourceName: "Official Club",
  canonicalUrl: "https://club.test/news/transfer",
  publishedAt: new Date("2026-08-10T01:00:00.000Z"),
  sourcePriority: 10,
  topicScore: 3,
};

describe("repository", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM drafts"),
      env.DB.prepare("DELETE FROM articles"),
      env.DB.prepare("DELETE FROM scheduled_runs"),
      env.DB.prepare("DELETE FROM daily_usage"),
    ]);
  });

  it("accepts a run slot only once", async () => {
    expect(await beginRun(env.DB, "2026-08-10T01:07Z", "2026-08-10")).toBe(true);
    expect(await beginRun(env.DB, "2026-08-10T01:07Z", "2026-08-10")).toBe(false);
  });

  it("records a canonical URL once using bound values", async () => {
    const hostileArticle = {
      ...article,
      title: "'); DROP TABLE articles; --",
    };

    const articleId = await recordArticle(env.DB, hostileArticle, true);

    expect(articleId).toBeTypeOf("number");
    expect(await recordArticle(env.DB, hostileArticle, true)).toBeNull();
    expect(await getSeenUrls(env.DB, [article.canonicalUrl, "https://new.test/story"])).toEqual(
      new Set([article.canonicalUrl]),
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM articles").first<number>("total")).toBe(1);
  });

  it("rejects the sixth Gemini reservation in one Vietnam day", async () => {
    for (let index = 0; index < 5; index += 1) {
      const key = `slot-${index}`;
      await beginRun(env.DB, key, "2026-08-10");
      expect(await reserveGeminiRequest(env.DB, key, "2026-08-10")).toBe(true);
    }

    await beginRun(env.DB, "slot-6", "2026-08-10");
    expect(await reserveGeminiRequest(env.DB, "slot-6", "2026-08-10")).toBe(false);
    expect(
      await env.DB
        .prepare("SELECT gemini_requests FROM daily_usage WHERE local_date = ?")
        .bind("2026-08-10")
        .first<number>("gemini_requests"),
    ).toBe(5);
  });

  it("does not reserve or leave quota elevated for a pre-marked duplicate slot", async () => {
    await beginRun(env.DB, "slot-1", "2026-08-10");
    expect(await reserveGeminiRequest(env.DB, "slot-1", "2026-08-10")).toBe(true);

    expect(await reserveGeminiRequest(env.DB, "slot-1", "2026-08-10")).toBe(false);
    expect(
      await env.DB
        .prepare("SELECT gemini_requests FROM daily_usage WHERE local_date = ?")
        .bind("2026-08-10")
        .first<number>("gemini_requests"),
    ).toBe(1);
  });

  it("creates a draft and stores its Telegram message identifier", async () => {
    const articleId = await recordArticle(env.DB, article, true);
    expect(articleId).not.toBeNull();

    const draftId = await createDraft(env.DB, articleId!, "A factual draft.");
    expect(await setDraftTelegramMessage(env.DB, draftId, 912)).toBe(true);
    expect(
      await env.DB
        .prepare("SELECT telegram_message_id FROM drafts WHERE id = ?")
        .bind(draftId)
        .first<number>("telegram_message_id"),
    ).toBe(912);
  });

  it("preserves the first terminal state on repeated callbacks", async () => {
    const articleId = await recordArticle(env.DB, article, true);
    const draftId = await createDraft(env.DB, articleId!, "A factual draft.");

    expect(
      await transitionDraft(env.DB, draftId, "approved", new Date("2026-08-10T02:00:00.000Z")),
    ).toBe("approved");
    expect(
      await transitionDraft(env.DB, draftId, "rejected", new Date("2026-08-10T03:00:00.000Z")),
    ).toBe("approved");
    expect(
      await env.DB
        .prepare("SELECT decided_at FROM drafts WHERE id = ?")
        .bind(draftId)
        .first<string>("decided_at"),
    ).toBe("2026-08-10T02:00:00.000Z");
  });

  it("completes an existing run with a bound summary", async () => {
    await beginRun(env.DB, "slot-1", "2026-08-10");

    expect(await completeRun(env.DB, "slot-1", "failed", "gemini_timeout")).toBe(true);
    expect(
      await env.DB
        .prepare("SELECT outcome, error_summary FROM scheduled_runs WHERE slot_key = ?")
        .bind("slot-1")
        .first(),
    ).toMatchObject({ outcome: "failed", error_summary: "gemini_timeout" });
  });
});
