import { parseFeeds } from "./config";
import { generateDraft } from "./gemini";
import { selectBestCandidate } from "./ranking";
import {
  beginRun,
  completeRun,
  createDraft,
  getSeenUrls,
  recordArticle,
  reserveGeminiRequest,
  setDraftTelegramMessage,
} from "./repository";
import { fetchFeedEntries } from "./rss";
import { TelegramClient } from "./telegram";
import type { Env } from "./types";

const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

export async function runScheduledPipeline(
  env: Env,
  scheduledTime: number,
  fetcher: typeof fetch,
): Promise<void> {
  const scheduledAt = new Date(scheduledTime);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("invalid_scheduled_time");
  }

  const slotKey = toSlotKey(scheduledAt);
  const localDate = toVietnamDate(scheduledAt);
  let runStarted = false;
  let draftId: number | null = null;
  try {
    runStarted = await beginRun(env.DB, slotKey, localDate, scheduledAt);
    if (!runStarted) {
      return;
    }

    const feeds = parseFeeds(env.RSS_FEEDS_JSON);
    let failedFeeds = 0;
    const entries = await fetchFeedEntries(feeds, fetcher, scheduledAt, () => {
      failedFeeds += 1;
    });
    if (failedFeeds > 0) {
      console.error("rss_feed_error");
    }
    if (feeds.length > 0 && failedFeeds === feeds.length) {
      await completeRun(env.DB, slotKey, "failed", "rss_unavailable", scheduledAt);
      return;
    }

    const seenUrls = await getSeenUrls(env.DB, entries.map((entry) => entry.canonicalUrl));
    const candidate = selectBestCandidate(entries, seenUrls, scheduledAt);
    if (!candidate) {
      await completeRun(env.DB, slotKey, "no_candidate", null, scheduledAt);
      return;
    }

    const articleId = await recordArticle(env.DB, candidate, true, scheduledAt);
    if (articleId === null) {
      await completeRun(env.DB, slotKey, "no_candidate", null, scheduledAt);
      return;
    }

    if (!(await reserveGeminiRequest(env.DB, slotKey, localDate))) {
      await completeRun(env.DB, slotKey, "failed", "daily_quota", scheduledAt);
      console.error("daily_quota");
      return;
    }

    const body = await generateDraft(
      candidate,
      { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL },
      fetcher,
    );
    draftId = await createDraft(env.DB, articleId, body, scheduledAt);

    const telegram = new TelegramClient(
      { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID },
      fetcher,
    );
    const telegramMessageId = await telegram.sendDraft({
      id: draftId,
      body,
      canonicalUrl: candidate.canonicalUrl,
    });
    if (!(await setDraftTelegramMessage(env.DB, draftId, telegramMessageId))) {
      throw new Error("draft_message_missing");
    }

    await completeRun(env.DB, slotKey, "draft_sent", null, scheduledAt);
  } catch (error) {
    const category = errorCategory(error);
    console.error(category);
    if (!runStarted) {
      return;
    }
    if (draftId !== null) {
      try {
        await env.DB
          .prepare("UPDATE drafts SET status = ? WHERE id = ? AND status = ?")
          .bind("failed", draftId, "pending")
          .run();
      } catch {
        console.error("pipeline_cleanup_error");
      }
    }
    try {
      await completeRun(env.DB, slotKey, "failed", category, scheduledAt);
    } catch {
      console.error("pipeline_cleanup_error");
    }
  }
}

function toSlotKey(value: Date): string {
  return `${value.toISOString().slice(0, 16)}Z`;
}

function toVietnamDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: VIETNAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "pipeline_error";
  if (error.message.startsWith("RSS_FEEDS_JSON")) return "config_error";
  const category = error.message.split(":", 1)[0];
  return /^[a-z][a-z0-9_]{0,63}$/.test(category) ? category : "pipeline_error";
}
