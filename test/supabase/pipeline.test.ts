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
import { selectEditorialCandidate } from "../../supabase/functions/_shared/ranking";
import { fetchFeedEntries } from "../../supabase/functions/_shared/rss";
import type {
  SelectionHistory,
  SelectionResult,
} from "../../supabase/functions/_shared/editorial-types";
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

  it("does not spend quota or send messages when history cannot be read", async () => {
    const context = setup();
    context.repository.historyError = true;

    expect(await runScheduledPipeline(context.dependencies, NOW)).toBe("internal_failed");
    expect(context.selectCandidate).not.toHaveBeenCalled();
    expect(context.repository.reservations).toHaveLength(0);
    expect(context.generate).not.toHaveBeenCalled();
    expect(context.telegramFetch).not.toHaveBeenCalled();
  });

  it("passes delivery and attempt history into the pure selector", async () => {
    const context = setup();
    context.repository.history = { delivered: [ARTICLE], selected: [ARTICLE] };
    context.selectCandidate.mockReturnValue(null);

    await runScheduledPipeline(context.dependencies, NOW);

    expect(context.selectCandidate).toHaveBeenCalledWith(
      [ARTICLE],
      new Set(),
      NOW,
      context.repository.history,
    );
    expect(context.generate).not.toHaveBeenCalled();
  });

  it("uses the real selector to prefer a diverse source before one Gemini call", async () => {
    const context = setup();
    const bbc = {
      ...ARTICLE,
      title: "Harry Kane joins Arsenal",
      sourceName: "BBC Sport Football",
      canonicalUrl: "https://www.bbc.co.uk/sport/football/articles/current",
    };
    const sky = {
      ...ARTICLE,
      title: "Cristiano Ronaldo says his next target is another trophy",
      excerpt: 'Cristiano Ronaldo said "My next target is to win another major trophy with this team".',
      sourceName: "Sky Sports Football",
      canonicalUrl: "https://www.skysports.com/football/news/sky-quote",
    };
    context.fetchFeeds.mockResolvedValue([bbc, sky]);
    context.repository.history = {
      delivered: [
        { ...bbc, canonicalUrl: "https://www.bbc.co.uk/sport/football/articles/old-1" },
        { ...bbc, canonicalUrl: "https://www.bbc.co.uk/sport/football/articles/old-2" },
      ],
      selected: [],
    };
    context.selectCandidate.mockImplementation(selectEditorialCandidate);

    await expect(runScheduledPipeline(context.dependencies, NOW)).resolves.toBe("draft_sent");

    expect(context.generate).toHaveBeenCalledOnce();
    expect(context.generate.mock.calls[0]?.[0]).toBe(sky);
    expect(context.repository.reservations).toHaveLength(1);
    expect(context.repository.events).toEqual(expect.arrayContaining(["reserve", "generate"]));
    expect(context.repository.events.indexOf("reserve"))
      .toBeLessThan(context.repository.events.indexOf("generate"));
  });

  it("does not generate after an exact URL claim collision", async () => {
    const context = setup();
    context.repository.articleId = null;

    await expect(runScheduledPipeline(context.dependencies, NOW)).resolves.toBe("no_candidate");

    expect(context.repository.reservations).toHaveLength(0);
    expect(context.generate).not.toHaveBeenCalled();
    expect(context.telegramFetch).not.toHaveBeenCalled();
  });

  it("logs only bounded RSS counters and editorial decision fields", async () => {
    const context = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    context.fetchFeeds.mockImplementation(async (_feeds, _fetcher, _now, _failure, diagnostic) => {
      diagnostic?.({ sourceId: "bbc", outcome: "failed", category: "http", items: 3,
        usable: 0, invalidDate: 1, invalidUrl: 1, invalidContent: 1 });
      return [{ ...ARTICLE, title: "PRIVATE_TITLE", excerpt: "PRIVATE_BODY" }];
    });
    context.selectCandidate.mockReturnValue(null);

    await runScheduledPipeline(context.dependencies, NOW);

    const serialized = log.mock.calls.flat().join("\n");
    expect(serialized).toContain('"event":"rss_feed"');
    expect(serialized).toContain('"items":3');
    expect(serialized).toContain('"event":"editorial_selection"');
    expect(serialized).not.toMatch(/PRIVATE_TITLE|PRIVATE_BODY|gemini-test-key|test-token/u);
    log.mockRestore();
  });

  it("treats a valid empty RSS feed as no_candidate without generation", async () => {
    const context = setup();
    const rssFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<rss><channel></channel></rss>", { status: 200 }),
    );
    const dependencies = {
      ...context.dependencies,
      feeds: [FEEDS[0]!],
      fetchFeeds: fetchFeedEntries,
      selectCandidate: selectEditorialCandidate,
      fetcher: rssFetch,
    };

    await expect(runScheduledPipeline(dependencies, NOW)).resolves.toBe("no_candidate");

    expect(context.generate).not.toHaveBeenCalled();
    expect(context.repository.reservations).toHaveLength(0);
  });

  it("treats a feed containing only invalid dates as unavailable", async () => {
    const context = setup();
    const rssFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(`
      <rss><channel><item>
        <title>Liverpool transfer news</title>
        <link>https://example.com/story</link>
        <pubDate>PRIVATE_INVALID_DATE</pubDate>
      </item></channel></rss>
    `, { status: 200 }));
    const dependencies = {
      ...context.dependencies,
      feeds: [FEEDS[0]!],
      fetchFeeds: fetchFeedEntries,
      fetcher: rssFetch,
    };

    await expect(runScheduledPipeline(dependencies, NOW)).resolves.toBe("rss_unavailable");

    expect(context.generate).not.toHaveBeenCalled();
    expect(context.repository.reservations).toHaveLength(0);
  });

  it("does not let a failing log sink change delivery", async () => {
    const context = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("log_sink_failed");
    });

    await expect(runScheduledPipeline(context.dependencies, NOW)).resolves.toBe("draft_sent");

    expect(context.generate).toHaveBeenCalledOnce();
    expect(context.telegramFetch).toHaveBeenCalledOnce();
    log.mockRestore();
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
    (): SelectionResult => ({
      article: ARTICLE,
      sourceId: "bbc",
      score: { event: 20, subjects: 5, freshness: 30, source: 15, total: 70 },
      diversityFallback: false,
      excess: 0,
      classifierVersion: "editorial-v1",
    }),
  );
  const generate = vi.fn<PipelineDependencies["generate"]>(
    async () => {
      repository.events.push("generate");
      return "An English football draft.";
    },
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
  readonly recordedArticles: Article[] = [];
  readonly telegramMessages: Array<{ draftId: number; messageId: number }> = [];
  readonly failedDraftIds: number[] = [];
  history: SelectionHistory = { delivered: [], selected: [] };
  historyError = false;
  articleId: number | null = 41;
  readonly events: string[] = [];
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

  async getSelectionHistory(): Promise<SelectionHistory> {
    if (this.historyError) throw new Error("repository_error:get_selection_history");
    return this.history;
  }

  async recordArticle(
    article: Article,
    eligible: boolean,
    _now: Date,
  ): Promise<number | null> {
    expect(eligible).toBe(true);
    this.recordedArticles.push(article);
    return this.articleId;
  }

  async reserveGeminiRequest(slotKey: string, localDate: string): Promise<boolean> {
    this.events.push("reserve");
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
