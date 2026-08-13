import { describe, expect, it, vi } from "vitest";
import type {
  Article,
  DraftDecision,
  DraftStatus,
  FeedDefinition,
  StoredDraft,
  TerminalRunOutcome,
} from "../../supabase/functions/_shared/domain-types";
import type { BotRepository } from "../../supabase/functions/_shared/repository";
import { TelegramClient } from "../../supabase/functions/_shared/telegram";
import {
  type PipelineDependencies,
  runScheduledPipeline,
} from "../../supabase/functions/_shared/pipeline";

const NOW = new Date("2026-08-12T01:07:30.000Z");
const SLOT_KEY = "2026-08-12T01:07Z";
const LOCAL_DATE = "2026-08-12";
const FEEDS: readonly FeedDefinition[] = [
  { name: "Primary", url: "https://feed.test/rss", priority: 100 },
  { name: "Backup", url: "https://backup.test/rss", priority: 80 },
];
const ARTICLE: Article = {
  title: "Liverpool complete transfer",
  excerpt: "The club confirmed the move.",
  sourceName: "Primary",
  canonicalUrl: "https://club.test/news/transfer",
  publishedAt: new Date("2026-08-12T00:30:00.000Z"),
  sourcePriority: 100,
  topicScore: 2,
};

describe("Supabase scheduled content pipeline", () => {
  it("records no_candidate without calling Gemini or Telegram", async () => {
    const context = setup();
    context.selectCandidate.mockReturnValue(null);

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("no_candidate");
    expect(context.generate).not.toHaveBeenCalled();
    expect(context.telegramFetch).not.toHaveBeenCalled();
    expect(context.repository.completions).toEqual([{
      slotKey: SLOT_KEY,
      outcome: "no_candidate",
      errorSummary: null,
    }]);
  });

  it("records rss_unavailable when every configured feed fails", async () => {
    const context = setup();
    context.fetchFeeds.mockImplementation(async (feeds, _fetcher, _now, onFailure) => {
      feeds.forEach((feed) => onFailure?.(feed.name));
      return [];
    });

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("rss_unavailable");
    expect(context.repository.completions[0]?.outcome).toBe("rss_unavailable");
    expect(context.generate).not.toHaveBeenCalled();
    expect(context.telegramFetch).not.toHaveBeenCalled();
  });

  it("records quota_limited when the daily reservation is rejected", async () => {
    const context = setup();
    context.repository.quotaAvailable = false;

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("quota_limited");
    expect(context.repository.reservations).toEqual([{
      slotKey: SLOT_KEY,
      localDate: LOCAL_DATE,
    }]);
    expect(context.generate).not.toHaveBeenCalled();
    expect(context.telegramFetch).not.toHaveBeenCalled();
  });

  it("creates and delivers exactly one reviewable draft", async () => {
    const context = setup();

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("draft_sent");
    expect(context.repository.createdDrafts).toEqual([{
      articleId: 41,
      body: "An English football draft.",
    }]);
    expect(context.repository.telegramMessages).toEqual([{
      draftId: 51,
      messageId: 314,
    }]);
    expect(context.repository.completions[0]?.outcome).toBe("draft_sent");
  });

  it("marks a generated draft failed when Telegram delivery fails", async () => {
    const context = setup({ telegramStatus: 502 });

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("telegram_failed");
    expect(context.repository.failedDraftIds).toEqual([51]);
    expect(context.repository.reservations).toHaveLength(1);
    expect(context.repository.completions[0]?.outcome).toBe("telegram_failed");
  });

  it("keeps a delivered draft pending when only run finalization fails", async () => {
    const context = setup();
    context.repository.failDraftSentCompletion = true;

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("internal_failed");
    expect(context.repository.telegramMessages).toEqual([{
      draftId: 51,
      messageId: 314,
    }]);
    expect(context.repository.failedDraftIds).toEqual([]);
    expect(context.repository.completions.at(-1)?.outcome).toBe("internal_failed");
  });

  it("disables an orphan Telegram message when its ID cannot be persisted", async () => {
    const context = setup();
    context.repository.storeTelegramMessage = false;

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("internal_failed");
    expect(context.telegramFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.telegram.org/bottest-token/sendMessage",
      "https://api.telegram.org/bottest-token/editMessageText",
    ]);
    expect(context.repository.failedDraftIds).toEqual([51]);
    expect(context.repository.completions[0]?.outcome).toBe("internal_failed");
  });

  it("preserves a delivered draft when persistence committed before transport failure", async () => {
    const context = setup();
    context.repository.telegramPersistenceError = "committed";

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("draft_sent");
    expect(context.repository.failedDraftIds).toEqual([]);
    expect(context.telegramFetch).toHaveBeenCalledOnce();
    expect(context.repository.completions[0]?.outcome).toBe("draft_sent");
  });

  it("compensates only after read-back confirms persistence did not commit", async () => {
    const context = setup();
    context.repository.telegramPersistenceError = "not_committed";

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("internal_failed");
    expect(context.repository.failedDraftIds).toEqual([51]);
    expect(context.telegramFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps unknown delivery state non-destructive when run completion also fails", async () => {
    const context = setup();
    context.repository.storeTelegramMessage = false;
    context.repository.readDeliveryError = true;
    context.repository.failInternalCompletionOnce = true;

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("internal_failed");
    expect(context.repository.failedDraftIds).toEqual([]);
    expect(context.telegramFetch).toHaveBeenCalledOnce();
  });

  it("does not claim telegram_failed unless draft cleanup is durable", async () => {
    const context = setup({ telegramStatus: 502 });
    context.repository.markDraftResult = false;

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("internal_failed");
    expect(context.repository.completions[0]?.outcome).toBe("internal_failed");
  });

  it("records gemini_failed without creating or delivering a draft", async () => {
    const context = setup();
    context.generate.mockRejectedValue(new Error("gemini_api_error:429"));

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("gemini_failed");
    expect(context.repository.createdDrafts).toEqual([]);
    expect(context.telegramFetch).not.toHaveBeenCalled();
    expect(context.repository.completions[0]).toMatchObject({
      outcome: "gemini_failed",
      errorSummary: "gemini_api_error",
    });
  });

  it("records internal_failed for an unexpected repository failure", async () => {
    const context = setup();
    context.repository.getSeenUrlsError = true;

    const result = await runScheduledPipeline(context.dependencies, NOW);

    expect(result).toBe("internal_failed");
    expect(context.generate).not.toHaveBeenCalled();
    expect(context.telegramFetch).not.toHaveBeenCalled();
    expect(context.repository.completions[0]?.outcome).toBe("internal_failed");
  });

  it("treats a repeated UTC-minute slot as a no-op", async () => {
    const context = setup();
    context.selectCandidate.mockReturnValue(null);

    await expect(runScheduledPipeline(context.dependencies, NOW)).resolves.toBe(
      "no_candidate",
    );
    await expect(runScheduledPipeline(context.dependencies, NOW)).resolves.toBe(
      "duplicate",
    );

    expect(context.fetchFeeds).toHaveBeenCalledOnce();
    expect(context.generate).not.toHaveBeenCalled();
    expect(context.telegramFetch).not.toHaveBeenCalled();
    expect(context.repository.completions).toHaveLength(1);
  });

  it("derives the quota date in Asia/Ho_Chi_Minh across UTC midnight", async () => {
    const context = setup();
    context.repository.expectedLocalDate = "2026-08-13";
    context.selectCandidate.mockReturnValue(null);

    await expect(runScheduledPipeline(
      context.dependencies,
      new Date("2026-08-12T17:07:30.000Z"),
    )).resolves.toBe("no_candidate");

    expect(context.repository.completions[0]?.slotKey).toBe(
      "2026-08-12T17:07Z",
    );
  });
});

function setup(options: { telegramStatus?: number } = {}) {
  const repository = new PipelineRepository();
  const fetchFeeds = vi.fn<PipelineDependencies["fetchFeeds"]>(
    async () => [ARTICLE],
  );
  const selectCandidate = vi.fn<PipelineDependencies["selectCandidate"]>(
    (): Article | null => ARTICLE,
  );
  const generate = vi.fn<PipelineDependencies["generate"]>(
    async () => "An English football draft.",
  );
  const telegramFetch = vi.fn<typeof fetch>().mockResolvedValue(
    options.telegramStatus
      ? new Response("provider failure", { status: options.telegramStatus })
      : Response.json({ ok: true, result: { message_id: 314 } }),
  );
  const telegram = new TelegramClient(
    { botToken: "test-token", chatId: "1331364954" },
    telegramFetch,
  );
  const dependencies = {
    repository,
    fetchFeeds,
    selectCandidate,
    generate,
    telegram,
    feeds: FEEDS,
    geminiConfig: { apiKey: "gemini-test-key", model: "test-model" },
    fetcher: vi.fn<typeof fetch>(),
  };
  return {
    repository,
    fetchFeeds,
    selectCandidate,
    generate,
    telegramFetch,
    dependencies,
  };
}

class PipelineRepository implements BotRepository {
  readonly slots = new Set<string>();
  readonly completions: Array<{
    slotKey: string;
    outcome: TerminalRunOutcome;
    errorSummary: string | null;
  }> = [];
  readonly reservations: Array<{ slotKey: string; localDate: string }> = [];
  readonly createdDrafts: Array<{ articleId: number; body: string }> = [];
  readonly telegramMessages: Array<{ draftId: number; messageId: number }> = [];
  readonly failedDraftIds: number[] = [];
  quotaAvailable = true;
  getSeenUrlsError = false;
  expectedLocalDate = LOCAL_DATE;
  storeTelegramMessage = true;
  markDraftResult = true;
  failDraftSentCompletion = false;
  telegramPersistenceError: "committed" | "not_committed" | null = null;
  storedTelegramMessageId: number | null = null;
  readDeliveryError = false;
  failInternalCompletionOnce = false;

  async beginRun(slotKey: string, localDate: string, _now: Date): Promise<boolean> {
    expect(localDate).toBe(this.expectedLocalDate);
    if (this.slots.has(slotKey)) return false;
    this.slots.add(slotKey);
    return true;
  }

  async getSeenUrls(_canonicalUrls: readonly string[]): Promise<Set<string>> {
    if (this.getSeenUrlsError) throw new Error("repository_error:get_seen_urls");
    return new Set();
  }

  async recordArticle(
    article: Article,
    eligible: boolean,
    _now: Date,
  ): Promise<number | null> {
    expect(article).toBe(ARTICLE);
    expect(eligible).toBe(true);
    return 41;
  }

  async reserveGeminiRequest(slotKey: string, localDate: string): Promise<boolean> {
    this.reservations.push({ slotKey, localDate });
    return this.quotaAvailable;
  }

  async createDraft(articleId: number, body: string, _now: Date): Promise<number> {
    this.createdDrafts.push({ articleId, body });
    return 51;
  }

  async setDraftTelegramMessage(draftId: number, messageId: number): Promise<boolean> {
    this.telegramMessages.push({ draftId, messageId });
    if (this.telegramPersistenceError === "committed") {
      this.storedTelegramMessageId = messageId;
      throw new Error("repository_error:set_draft_telegram_message");
    }
    if (this.telegramPersistenceError === "not_committed") {
      throw new Error("repository_error:set_draft_telegram_message");
    }
    if (this.storeTelegramMessage) this.storedTelegramMessageId = messageId;
    return this.storeTelegramMessage;
  }

  async markDraftFailed(draftId: number): Promise<boolean> {
    this.failedDraftIds.push(draftId);
    return this.markDraftResult;
  }

  async completeRun(
    slotKey: string,
    outcome: TerminalRunOutcome,
    errorSummary: string | null,
    _now: Date,
  ): Promise<boolean> {
    if (outcome === "draft_sent" && this.failDraftSentCompletion) {
      this.failDraftSentCompletion = false;
      throw new Error("repository_error:complete_run");
    }
    if (outcome === "internal_failed" && this.failInternalCompletionOnce) {
      this.failInternalCompletionOnce = false;
      throw new Error("repository_error:complete_run");
    }
    this.completions.push({ slotKey, outcome, errorSummary });
    return true;
  }

  async getDraftForCallback(draftId: number): Promise<StoredDraft | null> {
    if (this.readDeliveryError) {
      throw new Error("repository_error:get_draft_for_callback");
    }
    if (draftId !== 51) return null;
    return {
      body: "An English football draft.",
      canonicalUrl: ARTICLE.canonicalUrl,
      status: "pending",
      telegramMessageId: this.storedTelegramMessageId,
    };
  }
  transitionDraft(
    _draftId: number,
    _decision: DraftDecision,
    _now: Date,
  ): Promise<DraftStatus | null> {
    return Promise.reject(new Error("unexpected_transition"));
  }
}
