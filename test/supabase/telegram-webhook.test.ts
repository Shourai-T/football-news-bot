import { describe, expect, it, vi } from "vitest";
import type {
  Article,
  DraftDecision,
  DraftStatus,
  StoredDraft,
  TerminalRunOutcome,
} from "../../supabase/functions/_shared/domain-types";
import type { BotRepository } from "../../supabase/functions/_shared/repository";
import { createTelegramWebhookHandler } from "../../supabase/functions/telegram-webhook/handler";

const ENV = new Map([
  ["TELEGRAM_BOT_TOKEN", "test-token"],
  ["TELEGRAM_CHAT_ID", "1331364954"],
  ["TELEGRAM_WEBHOOK_SECRET", "webhook-test-secret"],
]);

function callbackRequest(
  draftId: number,
  options: {
    secret?: string;
    chatId?: number;
    data?: string;
    messageId?: number;
  } = {},
): Request {
  return new Request("https://project.supabase.co/functions/v1/telegram-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": options.secret ?? "webhook-test-secret",
    },
    body: JSON.stringify({
      update_id: 100,
      callback_query: {
        id: "callback-query-1",
        from: { id: 1_331_364_954, is_bot: false },
        data: options.data ?? `a:${draftId}`,
        message: {
          message_id: options.messageId ?? 314,
          date: 1_786_357_502,
          chat: {
            id: options.chatId ?? 1_331_364_954,
            type: "private",
          },
        },
      },
    }),
  });
}

function successfulTelegram(): typeof fetch {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    ok: true,
    result: true,
  }));
}

describe("Supabase Telegram approval webhook", () => {
  it("accepts only POST without touching repository or Telegram", async () => {
    const repository = new MemoryRepository();
    const fetcher = vi.fn<typeof fetch>();
    const handler = createTelegramWebhookHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
      repository,
    });

    const response = await handler(new Request(
      "https://project.supabase.co/functions/v1/telegram-webhook",
    ));

    expect(response.status).toBe(405);
    expect(repository.reads).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an invalid secret before repository or Telegram access", async () => {
    const repository = new MemoryRepository();
    repository.seedDraft(7);
    const fetcher = vi.fn<typeof fetch>();
    const handler = createTelegramWebhookHandler({
      readEnv: (name) => name === "TELEGRAM_WEBHOOK_SECRET"
        ? "webhook-test-secret"
        : undefined,
      fetcher,
      repository,
    });

    const response = await handler(callbackRequest(7, { secret: "wrong" }));

    expect(response.status).toBe(401);
    expect(repository.reads).toBe(0);
    expect(repository.drafts.get(7)?.status).toBe("pending");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects foreign chats and mismatched Telegram message IDs", async () => {
    const repository = new MemoryRepository();
    repository.seedDraft(7);
    const fetcher = successfulTelegram();
    const handler = createTelegramWebhookHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
      repository,
    });

    const foreign = await handler(callbackRequest(7, { chatId: 999 }));
    const mismatched = await handler(callbackRequest(7, { messageId: 315 }));

    expect(foreign.status).toBe(403);
    expect(mismatched.status).toBe(403);
    expect(repository.drafts.get(7)?.status).toBe("pending");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects callback data outside compact approve and reject actions", async () => {
    const repository = new MemoryRepository();
    repository.seedDraft(7);
    const fetcher = vi.fn<typeof fetch>();
    const handler = createTelegramWebhookHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
      repository,
    });

    const response = await handler(callbackRequest(7, { data: "v:1" }));

    expect(response.status).toBe(400);
    expect(repository.reads).toBe(0);
    expect(repository.drafts.get(7)?.status).toBe("pending");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("atomically approves and renders a pending draft", async () => {
    const repository = new MemoryRepository();
    repository.seedDraft(7);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      ok: true,
      result: true,
    }));
    const handler = createTelegramWebhookHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
      repository,
    });

    const response = await handler(callbackRequest(7));

    expect(response.status).toBe(200);
    expect(repository.drafts.get(7)?.status).toBe("approved");
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.telegram.org/bottest-token/answerCallbackQuery",
      "https://api.telegram.org/bottest-token/editMessageText",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      callback_query_id: "callback-query-1",
      text: "Approved",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      chat_id: "1331364954",
      message_id: 314,
      text: "A factual draft.\n\nSource: https://club.test/news/transfer\n\nStatus: APPROVED",
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("rejects a pending draft and keeps repeated callbacks idempotent", async () => {
    const repository = new MemoryRepository();
    repository.seedDraft(7);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      ok: true,
      result: true,
    }));
    const handler = createTelegramWebhookHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
      repository,
    });

    const rejected = await handler(callbackRequest(7, { data: "r:7" }));
    const repeated = await handler(callbackRequest(7, { data: "a:7" }));

    expect(rejected.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(repository.drafts.get(7)?.status).toBe("rejected");
    const answers = fetcher.mock.calls
      .filter(([url]) => String(url).endsWith("/answerCallbackQuery"))
      .map(([, init]) => JSON.parse(String(init?.body)).text);
    expect(answers).toEqual(["Rejected", "Already rejected"]);
  });

  it("returns 502 on Telegram failure without reverting the durable decision", async () => {
    const repository = new MemoryRepository();
    repository.seedDraft(7);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("provider detail", { status: 502 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }));
    const handler = createTelegramWebhookHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
      repository,
    });

    const response = await handler(callbackRequest(7));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ status: "provider_error" });
    expect(repository.drafts.get(7)?.status).toBe("approved");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

class MemoryRepository implements BotRepository {
  readonly drafts = new Map<number, StoredDraft>();
  reads = 0;

  seedDraft(id: number): void {
    this.drafts.set(id, {
      body: "A factual draft.",
      canonicalUrl: "https://club.test/news/transfer",
      status: "pending",
      telegramMessageId: 314,
    });
  }

  async getDraftForCallback(draftId: number): Promise<StoredDraft | null> {
    this.reads += 1;
    return this.drafts.get(draftId) ?? null;
  }

  async transitionDraft(
    draftId: number,
    decision: DraftDecision,
    _now: Date,
  ): Promise<DraftStatus | null> {
    const draft = this.drafts.get(draftId);
    if (!draft) return null;
    if (draft.status === "pending") draft.status = decision;
    return draft.status;
  }

  beginRun(_slotKey: string, _localDate: string, _now: Date): Promise<boolean> {
    return Promise.reject(new Error("unexpected_begin_run"));
  }
  getSeenUrls(_canonicalUrls: readonly string[]): Promise<Set<string>> {
    return Promise.reject(new Error("unexpected_get_seen_urls"));
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
  markDraftFailed(_draftId: number): Promise<boolean> {
    return Promise.reject(new Error("unexpected_mark_failed"));
  }
  completeRun(
    _slotKey: string,
    _outcome: TerminalRunOutcome,
    _errorSummary: string | null,
    _now: Date,
  ): Promise<boolean> {
    return Promise.reject(new Error("unexpected_complete_run"));
  }
}
