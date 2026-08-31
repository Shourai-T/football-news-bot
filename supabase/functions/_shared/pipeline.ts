import type {
  FeedDefinition,
  GeminiConfig,
  TerminalRunOutcome,
} from "./domain-types.ts";
import { generateDraft } from "./gemini.ts";
import { selectEditorialCandidate } from "./ranking.ts";
import type { BotRepository } from "./repository.ts";
import { fetchFeedEntries, type FeedDiagnostic } from "./rss.ts";
import type { TelegramClient } from "./telegram.ts";

const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

export type PipelineRunOutcome = TerminalRunOutcome | "duplicate";

export interface PipelineDependencies {
  repository: BotRepository;
  fetchFeeds: typeof fetchFeedEntries;
  selectCandidate: typeof selectEditorialCandidate;
  generate: typeof generateDraft;
  telegram: Pick<TelegramClient, "sendDraft" | "editDraftState">;
  feeds: readonly FeedDefinition[];
  geminiConfig: GeminiConfig;
  fetcher: typeof fetch;
}

export async function runScheduledPipeline(
  dependencies: PipelineDependencies,
  scheduledAt: Date,
): Promise<PipelineRunOutcome> {
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("invalid_scheduled_time");
  }

  const slotKey = toSlotKey(scheduledAt);
  const localDate = toVietnamDate(scheduledAt);
  const started = await dependencies.repository.beginRun(
    slotKey,
    localDate,
    scheduledAt,
  );
  if (!started) return "duplicate";

  let draftId: number | null = null;
  let messageSent = false;
  let deliveryStored = false;
  try {
    let failedFeeds = 0;
    let entries;
    try {
      entries = await dependencies.fetchFeeds(
        dependencies.feeds,
        dependencies.fetcher,
        scheduledAt,
        () => {
          failedFeeds += 1;
        },
        (diagnostic) => logFeedDiagnostic(slotKey, diagnostic),
      );
    } catch (error) {
      return await completeFailure(
        dependencies.repository,
        slotKey,
        "rss_unavailable",
        errorCategory(error, "rss_error"),
        scheduledAt,
      );
    }

    if (
      dependencies.feeds.length > 0 &&
      failedFeeds === dependencies.feeds.length
    ) {
      return await completeFailure(
        dependencies.repository,
        slotKey,
        "rss_unavailable",
        "rss_unavailable",
        scheduledAt,
      );
    }

    const [seenUrls, history] = await Promise.all([
      dependencies.repository.getSeenUrls(
        entries.map((entry) => entry.canonicalUrl),
      ),
      dependencies.repository.getSelectionHistory(scheduledAt),
    ]);
    const selection = dependencies.selectCandidate(
      entries,
      seenUrls,
      scheduledAt,
      history,
    );
    if (selection === null) {
      logEvent("editorial_selection", { slotKey, outcome: "no_candidate" });
      return await complete(
        dependencies.repository,
        slotKey,
        "no_candidate",
        null,
        scheduledAt,
      );
    }
    const candidate = selection.article;

    const articleId = await dependencies.repository.recordArticle(
      candidate,
      true,
      scheduledAt,
    );
    if (articleId === null) {
      logEvent("editorial_selection", { slotKey, outcome: "claim_collision" });
      return await complete(
        dependencies.repository,
        slotKey,
        "no_candidate",
        null,
        scheduledAt,
      );
    }

    logEvent("editorial_selection", {
      slotKey,
      articleId,
      sourceId: selection.sourceId,
      classifierVersion: selection.classifierVersion,
      scoreEvent: selection.score.event,
      scoreSubjects: selection.score.subjects,
      scoreFreshness: selection.score.freshness,
      scoreSource: selection.score.source,
      scoreTotal: selection.score.total,
      excess: selection.excess,
      diversityFallback: Number(selection.diversityFallback),
    });

    const reserved = await dependencies.repository.reserveGeminiRequest(
      slotKey,
      localDate,
    );
    if (!reserved) {
      return await complete(
        dependencies.repository,
        slotKey,
        "quota_limited",
        null,
        scheduledAt,
      );
    }

    let body: string;
    try {
      body = await dependencies.generate(
        candidate,
        dependencies.geminiConfig,
        dependencies.fetcher,
      );
    } catch (error) {
      return await completeFailure(
        dependencies.repository,
        slotKey,
        "gemini_failed",
        errorCategory(error, "gemini_error"),
        scheduledAt,
      );
    }

    draftId = await dependencies.repository.createDraft(
      articleId,
      body,
      scheduledAt,
    );
    let messageId: number;
    try {
      messageId = await dependencies.telegram.sendDraft({
        id: draftId,
        body,
        canonicalUrl: candidate.canonicalUrl,
      });
      messageSent = true;
    } catch (error) {
      const cleanupSucceeded = await markDraftFailed(
        dependencies.repository,
        draftId,
      );
      return await completeFailure(
        dependencies.repository,
        slotKey,
        cleanupSucceeded ? "telegram_failed" : "internal_failed",
        cleanupSucceeded
          ? errorCategory(error, "telegram_error")
          : "draft_cleanup_failed",
        scheduledAt,
      );
    }

    let persistenceState: "stored" | "absent" | "unknown";
    let persistenceCategory = "telegram_message_not_stored";
    try {
      const stored = await dependencies.repository.setDraftTelegramMessage(
        draftId,
        messageId,
      );
      persistenceState = stored
        ? "stored"
        : await readDeliveryState(
          dependencies.repository,
          draftId,
          messageId,
        );
    } catch (error) {
      persistenceCategory = errorCategory(
        error,
        "telegram_message_persistence_error",
      );
      persistenceState = await readDeliveryState(
        dependencies.repository,
        draftId,
        messageId,
      );
    }

    if (persistenceState === "stored") {
      deliveryStored = true;
    } else if (persistenceState === "absent") {
      const [draftCleaned, messageDisabled] = await Promise.all([
        markDraftFailed(dependencies.repository, draftId),
        disableOrphanMessage(
          dependencies.telegram,
          draftId,
          messageId,
          `${body}\n\nSource: ${candidate.canonicalUrl}`,
        ),
      ]);
      return await completeFailure(
        dependencies.repository,
        slotKey,
        "internal_failed",
        draftCleaned && messageDisabled
          ? persistenceCategory
          : "delivery_compensation_failed",
        scheduledAt,
      );
    } else {
      return await completeFailure(
        dependencies.repository,
        slotKey,
        "internal_failed",
        "delivery_state_unknown",
        scheduledAt,
      );
    }

    return await complete(
      dependencies.repository,
      slotKey,
      "draft_sent",
      null,
      scheduledAt,
    );
  } catch (error) {
    if (draftId !== null && !messageSent && !deliveryStored) {
      await markDraftFailed(dependencies.repository, draftId);
    }
    try {
      return await completeFailure(
        dependencies.repository,
        slotKey,
        "internal_failed",
        errorCategory(error, "pipeline_error"),
        scheduledAt,
      );
    } catch {
      return "internal_failed";
    }
  }
}

export function toSlotKey(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error("invalid_scheduled_time");
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

async function complete(
  repository: BotRepository,
  slotKey: string,
  outcome: TerminalRunOutcome,
  errorSummary: string | null,
  now: Date,
): Promise<TerminalRunOutcome> {
  if (!(await repository.completeRun(slotKey, outcome, errorSummary, now))) {
    throw new Error("repository_error:complete_run");
  }
  return outcome;
}

async function completeFailure(
  repository: BotRepository,
  slotKey: string,
  outcome: Extract<
    TerminalRunOutcome,
    "rss_unavailable" | "gemini_failed" | "telegram_failed" | "internal_failed"
  >,
  category: string,
  now: Date,
): Promise<TerminalRunOutcome> {
  logEvent("scheduled_run_failed", { slotKey, category });
  return await complete(repository, slotKey, outcome, category, now);
}

async function markDraftFailed(
  repository: BotRepository,
  draftId: number,
): Promise<boolean> {
  try {
    return await repository.markDraftFailed(draftId);
  } catch {
    logEvent("draft_cleanup_failed", { draftId, category: "repository_error" });
    return false;
  }
}

async function disableOrphanMessage(
  telegram: Pick<TelegramClient, "editDraftState">,
  draftId: number,
  messageId: number,
  currentText: string,
): Promise<boolean> {
  try {
    await telegram.editDraftState(messageId, currentText, "failed");
    return true;
  } catch {
    logEvent("telegram_compensation_failed", {
      draftId,
      category: "telegram_error",
    });
    return false;
  }
}

async function readDeliveryState(
  repository: BotRepository,
  draftId: number,
  messageId: number,
): Promise<"stored" | "absent" | "unknown"> {
  try {
    const draft = await repository.getDraftForCallback(draftId);
    if (draft?.status !== "pending") return "unknown";
    if (draft.telegramMessageId === messageId) return "stored";
    if (draft.telegramMessageId === null) return "absent";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function errorCategory(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const category = error.message.split(":", 1)[0];
  return /^[a-z][a-z0-9_]{0,63}$/u.test(category) ? category : fallback;
}

function logEvent(
  event: string,
  fields: Record<string, string | number>,
): void {
  try {
    console.error(JSON.stringify({ event, ...fields }));
  } catch {
    // Logging is best-effort and must not affect durable pipeline state.
  }
}

function logFeedDiagnostic(slotKey: string, diagnostic: FeedDiagnostic): void {
  try {
    logEvent("rss_feed", {
      slotKey,
      sourceId: diagnostic.sourceId,
      outcome: diagnostic.outcome,
      category: diagnostic.category,
      items: diagnostic.items,
      usable: diagnostic.usable,
      invalidDate: diagnostic.invalidDate,
      invalidUrl: diagnostic.invalidUrl,
      invalidContent: diagnostic.invalidContent,
    });
  } catch {
    // Observability must never change a completed delivery into a failure.
  }
}
