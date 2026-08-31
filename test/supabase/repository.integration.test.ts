import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";
import { createAdminClient } from "../../supabase/functions/_shared/database-client";
import type { Database } from "../../supabase/functions/_shared/database.types";
import type {
  Article,
  XPostingMode,
} from "../../supabase/functions/_shared/domain-types";
import { SupabaseBotRepository } from "../../supabase/functions/_shared/repository";

const NOW = new Date("2026-08-12T01:07:00.000Z");
const LOCAL_DATE = "2026-08-12";
const BASE_ARTICLE: Article = {
  title: "Liverpool complete a major transfer",
  excerpt: "The club confirmed the move in an official update.",
  sourceName: "Liverpool FC official",
  canonicalUrl: "https://example.com/articles/transfer",
  publishedAt: new Date("2026-08-12T00:30:00.000Z"),
  sourcePriority: 70,
  topicScore: 5,
};

const nodeEnv = (globalThis as typeof globalThis & {
  process: { env: Record<string, string | undefined> };
}).process.env;
const readEnv = (name: string): string | undefined => nodeEnv[name];
const client = createAdminClient(readEnv);
const repository = new SupabaseBotRepository(client);

beforeEach(async () => {
  const { error: settingsError } = await client
    .from("bot_settings")
    .update({
      x_posting_mode: "off",
      updated_at: NOW.toISOString(),
    })
    .eq("id", 1);
  if (settingsError) throw new Error("integration_cleanup_failed:bot_settings");
  await deleteAll(client, "drafts", "id");
  await deleteAll(client, "articles", "id");
  await deleteAll(client, "scheduled_runs", "slot_key");
  await deleteAll(client, "daily_usage", "local_date");
});

describe("Supabase bot repository", () => {
  it("reads and durably changes the singleton X posting mode", async () => {
    await expect(repository.getXPostingMode()).resolves.toBe("off");

    const changedAt = new Date("2026-08-12T01:10:00.000Z");
    await expect(repository.setXPostingMode("manual", changedAt)).resolves.toBe(
      "manual",
    );
    await expect(repository.getXPostingMode()).resolves.toBe("manual");

    const { data, error } = await client
      .from("bot_settings")
      .select("x_posting_mode,updated_at")
      .eq("id", 1)
      .single();
    expect(error).toBeNull();
    expect(data?.x_posting_mode).toBe("manual" satisfies XPostingMode);
    expect(new Date(data!.updated_at).getTime()).toBe(changedAt.getTime());
  });

  it("starts each scheduled slot at most once and completes it once", async () => {
    const slotKey = "2026-08-12T01:07Z";

    await expect(repository.beginRun(slotKey, LOCAL_DATE, NOW)).resolves.toBe(true);
    await expect(repository.beginRun(slotKey, LOCAL_DATE, NOW)).resolves.toBe(false);
    await expect(repository.completeRun(
      slotKey,
      "no_candidate",
      null,
      new Date("2026-08-12T01:07:03.000Z"),
    )).resolves.toBe(true);
    await expect(repository.completeRun(
      slotKey,
      "internal_failed",
      "late_update",
      new Date("2026-08-12T01:07:04.000Z"),
    )).resolves.toBe(false);
  });

  it("records a canonical article once and resolves seen URLs in bounded chunks", async () => {
    const firstId = await repository.recordArticle(BASE_ARTICLE, true, NOW);
    expect(firstId).toEqual(expect.any(Number));
    await expect(repository.recordArticle(BASE_ARTICLE, true, NOW)).resolves.toBeNull();

    const secondArticle = {
      ...BASE_ARTICLE,
      canonicalUrl: "https://example.com/articles/second",
      title: "Second article",
    };
    await expect(repository.recordArticle(secondArticle, true, NOW)).resolves.toEqual(
      expect.any(Number),
    );

    const requestedUrls = [
      BASE_ARTICLE.canonicalUrl,
      secondArticle.canonicalUrl,
      ...Array.from(
        { length: 998 },
        (_, index) => `https://example.com/unseen/${index.toString().padStart(4, "0")}/${"x".repeat(64)}`,
      ),
    ];

    await expect(repository.getSeenUrls(requestedUrls)).resolves.toEqual(new Set([
      BASE_ARTICLE.canonicalUrl,
      secondArticle.canonicalUrl,
    ]));
  });

  it("caps concurrent daily Gemini reservations at five and rejects retries", async () => {
    const slots = [1, 4, 7, 10, 13, 16].map(
      (hour) => `2026-08-12T${hour.toString().padStart(2, "0")}:07Z`,
    );
    for (const slot of slots) {
      await expect(repository.beginRun(slot, LOCAL_DATE, NOW)).resolves.toBe(true);
    }

    const reservations = await Promise.all(
      slots.map((slot) => repository.reserveGeminiRequest(slot, LOCAL_DATE)),
    );

    expect(reservations.filter(Boolean)).toHaveLength(5);
    expect(reservations.filter((reserved) => !reserved)).toHaveLength(1);
    const reservedSlot = slots[reservations.findIndex(Boolean)]!;
    await expect(repository.reserveGeminiRequest(reservedSlot, LOCAL_DATE)).resolves.toBe(false);

    const { data: usage, error: usageError } = await client
      .from("daily_usage")
      .select("gemini_requests")
      .eq("local_date", LOCAL_DATE)
      .single();
    expect(usageError).toBeNull();
    expect(usage?.gemini_requests).toBe(5);
  });

  it("stores Telegram delivery and preserves the first terminal draft decision", async () => {
    const articleId = await repository.recordArticle(BASE_ARTICLE, true, NOW);
    expect(articleId).toEqual(expect.any(Number));
    const draftId = await repository.createDraft(
      articleId!,
      "A valid English football post.",
      NOW,
    );

    await expect(repository.setDraftTelegramMessage(draftId, 77)).resolves.toBe(true);
    await expect(repository.getDraftForCallback(draftId)).resolves.toEqual({
      body: "A valid English football post.",
      canonicalUrl: BASE_ARTICLE.canonicalUrl,
      status: "pending",
      telegramMessageId: 77,
    });
    await expect(repository.transitionDraft(
      draftId,
      "approved",
      new Date("2026-08-12T01:08:00.000Z"),
    )).resolves.toBe("approved");
    await expect(repository.transitionDraft(
      draftId,
      "rejected",
      new Date("2026-08-12T01:09:00.000Z"),
    )).resolves.toBe("approved");
  });

  it("returns delivered diversity history and all recent selected attempts", async () => {
    for (const [index, status] of ["pending", "approved", "rejected", "failed", "unsent"].entries()) {
      const articleId = await repository.recordArticle({ ...BASE_ARTICLE,
        canonicalUrl: `https://example.com/history/${index}` }, true, NOW);
      const draftId = await repository.createDraft(articleId!, "Draft", NOW);
      if (["pending", "approved", "rejected"].includes(status)) {
        await repository.setDraftTelegramMessage(draftId, 100 + index);
      }
      if (status === "approved" || status === "rejected") await repository.transitionDraft(draftId, status, NOW);
      if (status === "failed") await repository.markDraftFailed(draftId);
    }
    const history = await repository.getSelectionHistory(NOW);
    expect(history.delivered).toHaveLength(3);
    expect(history.selected).toHaveLength(5);
  });

  it("paginates beyond 100 delivered and selected articles", async () => {
    const rows = Array.from({ length: 105 }, (_, index) => ({
      canonical_url: `https://example.com/paginated/${index}`, title: `Messi update ${index}`,
      source_name: "BBC Sport Football", published_at: NOW.toISOString(), excerpt: "",
      eligible: true, created_at: NOW.toISOString(),
    }));
    const { data: articles, error: articleError } = await client.from("articles").insert(rows).select("id");
    expect(articleError).toBeNull();
    const { error: draftError } = await client.from("drafts").insert(articles!.map((article, index) => ({
      article_id: article.id, body: `Draft ${index}`, telegram_message_id: 1_000 + index,
      status: "pending", created_at: NOW.toISOString(),
    })));
    expect(draftError).toBeNull();
    const history = await repository.getSelectionHistory(NOW);
    expect(history.delivered).toHaveLength(105);
    expect(history.selected).toHaveLength(105);
  });

  it("recognizes legacy BBC tracking URLs without matching adjacent paths", async () => {
    await repository.recordArticle({ ...BASE_ARTICLE,
      canonicalUrl: "https://www.bbc.co.uk/sport/football/articles/old?at_medium=RSS&at_campaign=rss",
      publishedAt: new Date("2026-01-01T00:00:00Z") }, true, NOW);
    await expect(repository.getSeenUrls([
      "https://www.bbc.co.uk/sport/football/articles/old",
      "https://www.bbc.co.uk/sport/football/articles/old-next",
    ])).resolves.toEqual(new Set(["https://www.bbc.co.uk/sport/football/articles/old"]));
  });

  it("marks an undelivered draft failed", async () => {
    const articleId = await repository.recordArticle(BASE_ARTICLE, true, NOW);
    const draftId = await repository.createDraft(
      articleId!,
      "A draft that Telegram did not receive.",
      NOW,
    );

    await expect(repository.markDraftFailed(draftId)).resolves.toBe(true);
    await expect(repository.markDraftFailed(draftId)).resolves.toBe(false);

    await expect(repository.getDraftForCallback(draftId)).resolves.toEqual({
      body: "A draft that Telegram did not receive.",
      canonicalUrl: BASE_ARTICLE.canonicalUrl,
      status: "failed",
      telegramMessageId: null,
    });
  });
});

async function deleteAll<
  Table extends "drafts" | "articles" | "scheduled_runs" | "daily_usage",
>(
  database: SupabaseClient<Database>,
  table: Table,
  primaryKey: "id" | "slot_key" | "local_date",
): Promise<void> {
  const { error } = await database
    .from(table)
    .delete()
    .not(primaryKey, "is", null);
  if (error) throw new Error(`integration_cleanup_failed:${table}`);
}
