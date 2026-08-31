import { describe, expect, it, vi } from "vitest";
import type {
  Article,
  DraftDecision,
  DraftStatus,
  StoredDraft,
  TerminalRunOutcome,
} from "../../supabase/functions/_shared/domain-types";
import type { BotRepository } from "../../supabase/functions/_shared/repository";
import { createScheduledPipelineHandler } from "../../supabase/functions/scheduled-pipeline/handler";

const NOW = new Date("2026-08-12T01:07:30.000Z");
const ENV = new Map([
  ["SCHEDULED_FUNCTION_SECRET", "scheduled-test-secret"],
  ["TELEGRAM_BOT_TOKEN", "test-token"],
  ["TELEGRAM_CHAT_ID", "1331364954"],
  ["GEMINI_API_KEY", "gemini-test-key"],
  ["GEMINI_MODEL", "gemini-3.5-flash-lite"],
]);

describe("scheduled pipeline HTTP handler", () => {
  it("authenticates before any database or provider call", async () => {
    const repository = new HandlerRepository();
    const fetcher = vi.fn<typeof fetch>();
    const handler = createScheduledPipelineHandler({
      readEnv: (name) => name === "SCHEDULED_FUNCTION_SECRET"
        ? "scheduled-test-secret"
        : undefined,
      fetcher,
      createRepository: () => repository,
      now: () => NOW,
    });

    const response = await handler(request("wrong-secret"));

    expect(response.status).toBe(401);
    expect(repository.beginCalls).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts only POST", async () => {
    const repository = new HandlerRepository();
    const handler = createScheduledPipelineHandler({
      readEnv: (name) => ENV.get(name),
      fetcher: vi.fn<typeof fetch>(),
      createRepository: () => repository,
      now: () => NOW,
    });

    const response = await handler(new Request("https://project.supabase.co/functions/v1/scheduled-pipeline"));

    expect(response.status).toBe(405);
    expect(repository.beginCalls).toBe(0);
  });

  it("returns a generic idempotent response for a duplicate slot", async () => {
    const repository = new HandlerRepository();
    repository.beginResult = false;
    const fetcher = vi.fn<typeof fetch>();
    const handler = createScheduledPipelineHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
      createRepository: () => repository,
      now: () => NOW,
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "duplicate",
      slotKey: "2026-08-12T01:07Z",
    });
    expect(repository.beginCalls).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function request(secret = "scheduled-test-secret"): Request {
  return new Request("https://project.supabase.co/functions/v1/scheduled-pipeline", {
    method: "POST",
    headers: { "X-Scheduled-Secret": secret },
  });
}

class HandlerRepository implements BotRepository {
  beginCalls = 0;
  beginResult = true;

  async beginRun(_slotKey: string, _localDate: string, _now: Date): Promise<boolean> {
    this.beginCalls += 1;
    return this.beginResult;
  }

  getSeenUrls(_canonicalUrls: readonly string[]): Promise<Set<string>> {
    return Promise.reject(new Error("unexpected_get_seen_urls"));
  }
  getSelectionHistory(_now: Date): Promise<never> {
    return Promise.reject(new Error("unexpected_get_selection_history"));
  }
  recordArticle(_article: Article, _eligible: boolean, _now: Date): Promise<number | null> {
    return Promise.reject(new Error("unexpected_record_article"));
  }
  reserveGeminiRequest(_slotKey: string, _localDate: string): Promise<boolean> {
    return Promise.reject(new Error("unexpected_reserve"));
  }
  createDraft(_articleId: number, _body: string, _now: Date): Promise<number> {
    return Promise.reject(new Error("unexpected_create_draft"));
  }
  setDraftTelegramMessage(_draftId: number, _messageId: number): Promise<boolean> {
    return Promise.reject(new Error("unexpected_set_message"));
  }
  getDraftForCallback(_draftId: number): Promise<StoredDraft | null> {
    return Promise.reject(new Error("unexpected_get_draft"));
  }
  transitionDraft(
    _draftId: number,
    _decision: DraftDecision,
    _now: Date,
  ): Promise<DraftStatus | null> {
    return Promise.reject(new Error("unexpected_transition"));
  }
  markDraftFailed(_draftId: number): Promise<boolean> {
    return Promise.reject(new Error("unexpected_mark_failed"));
  }
  completeRun(
    _slotKey: string,
    _outcome: TerminalRunOutcome,
    _errorSummary: string | null,
    _now: Date,
  ): Promise<boolean> {
    return Promise.reject(new Error("unexpected_complete"));
  }
}
