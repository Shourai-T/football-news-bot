import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramHealth } from "../src/diagnostic";
import worker from "../src/index";
import { createDraft, recordArticle, setDraftTelegramMessage } from "../src/repository";
import type { Article, Env } from "../src/types";
import { handleTelegramWebhook } from "../src/webhook";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const CHAT_ID = "-100123";
const WEBHOOK_SECRET = "webhook-test-secret";
const DIAGNOSTIC_SECRET = "diagnostic-test-secret";
const article: Article = {
  title: "Club agrees transfer",
  excerpt: "The transfer was confirmed by the club.",
  sourceName: "Official Club",
  canonicalUrl: "https://club.test/news/transfer",
  publishedAt: new Date("2026-08-10T01:00:00.000Z"),
  sourcePriority: 10,
  topicScore: 3,
};

function workerEnv(): Env {
  return {
    DB: env.DB,
    TELEGRAM_BOT_TOKEN: "telegram-test-token",
    TELEGRAM_CHAT_ID: CHAT_ID,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    DIAGNOSTIC_SECRET,
    GEMINI_API_KEY: "gemini-test-key",
    GEMINI_MODEL: "gemini-test-model",
    RSS_FEEDS_JSON: "[]",
  };
}

function callbackRequest(
  draftId: number,
  options: { secret?: string; chatId?: number; data?: string; messageId?: number } = {},
): Request {
  return new Request("https://worker.test/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": options.secret ?? WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      callback_query: {
        id: "callback-7",
        data: options.data ?? `a:${draftId}`,
        message: {
          message_id: options.messageId ?? 314,
          text: "A factual draft.",
          chat: { id: options.chatId ?? Number(CHAT_ID) },
        },
      },
    }),
  });
}

async function draftStatus(draftId: number): Promise<string | null> {
  return env.DB.prepare("SELECT status FROM drafts WHERE id = ?")
    .bind(draftId)
    .first<string>("status");
}

describe("Telegram webhook", () => {
  let draftId: number;

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
    const articleId = await recordArticle(env.DB, article, true);
    draftId = await createDraft(env.DB, articleId!, "A factual draft.");
    await setDraftTelegramMessage(env.DB, draftId, 314);
  });

  it("rejects an invalid Telegram secret before state changes", async () => {
    let externalCalls = 0;
    const fetcher: typeof fetch = async () => {
      externalCalls += 1;
      return Response.json({ ok: true, result: true });
    };

    const response = await handleTelegramWebhook(
      callbackRequest(draftId, { secret: "wrong" }),
      workerEnv(),
      fetcher,
    );

    expect(response.status).toBe(401);
    expect(await draftStatus(draftId)).toBe("pending");
    expect(externalCalls).toBe(0);
  });

  it("rejects a foreign callback chat before state changes", async () => {
    const response = await handleTelegramWebhook(
      callbackRequest(draftId, { chatId: -999 }),
      workerEnv(),
      async () => Response.json({ ok: true, result: true }),
    );

    expect(response.status).toBe(403);
    expect(await draftStatus(draftId)).toBe("pending");
  });

  it("rejects a callback from a different Telegram message before state changes", async () => {
    let externalCalls = 0;
    const response = await handleTelegramWebhook(
      callbackRequest(draftId, { messageId: 315 }),
      workerEnv(),
      async () => {
        externalCalls += 1;
        return Response.json({ ok: true, result: true });
      },
    );

    expect(response.status).toBe(403);
    expect(await draftStatus(draftId)).toBe("pending");
    expect(externalCalls).toBe(0);
  });

  it("rejects malformed callback data before state changes", async () => {
    const response = await handleTelegramWebhook(
      callbackRequest(draftId, { data: `approve:${draftId}` }),
      workerEnv(),
      async () => Response.json({ ok: true, result: true }),
    );

    expect(response.status).toBe(400);
    expect(await draftStatus(draftId)).toBe("pending");
  });

  it("atomically approves, acknowledges, and edits a pending draft", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({
        method: String(input).split("/").at(-1)!,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ ok: true, result: true });
    };

    const response = await handleTelegramWebhook(callbackRequest(draftId), workerEnv(), fetcher);

    expect(response.status).toBe(200);
    expect(await draftStatus(draftId)).toBe("approved");
    expect(calls).toEqual([
      {
        method: "answerCallbackQuery",
        body: { callback_query_id: "callback-7", text: "Approved" },
      },
      {
        method: "editMessageText",
        body: {
          chat_id: CHAT_ID,
          message_id: 314,
          text: `A factual draft.\n\nSource: ${article.canonicalUrl}\n\nStatus: APPROVED`,
          reply_markup: { inline_keyboard: [] },
        },
      },
    ]);
  });

  it("rejects a pending draft and renders the rejected state", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: true });
    };

    const response = await handleTelegramWebhook(
      callbackRequest(draftId, { data: `r:${draftId}` }),
      workerEnv(),
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await draftStatus(draftId)).toBe("rejected");
    expect(bodies[0]).toMatchObject({ text: "Rejected" });
    expect(bodies[1]).toMatchObject({
      message_id: 314,
      text: expect.stringContaining("Status: REJECTED"),
    });
  });

  it("keeps repeated approval idempotent", async () => {
    const callbackAnswers: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/answerCallbackQuery")) {
        callbackAnswers.push((JSON.parse(String(init?.body)) as { text: string }).text);
      }
      return Response.json({ ok: true, result: true });
    };

    await handleTelegramWebhook(callbackRequest(draftId), workerEnv(), fetcher);
    const repeated = await handleTelegramWebhook(
      callbackRequest(draftId, { data: `a:${draftId}` }),
      workerEnv(),
      fetcher,
    );

    expect(repeated.status).toBe(200);
    expect(await draftStatus(draftId)).toBe("approved");
    expect(callbackAnswers).toEqual(["Approved", "Already approved"]);
  });

  it("still edits the message when callback acknowledgement fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calledMethods: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const method = String(input).split("/").at(-1)!;
      calledMethods.push(method);
      return method === "answerCallbackQuery"
        ? Response.json({ ok: false }, { status: 500 })
        : Response.json({ ok: true, result: true });
    };

    const response = await handleTelegramWebhook(callbackRequest(draftId), workerEnv(), fetcher);

    expect(response.status).toBe(502);
    expect(await draftStatus(draftId)).toBe("approved");
    expect(calledMethods).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "webhook_provider_error", category: "telegram_api_error",
    }));
  });

  it("returns 502 after an edit failure even when acknowledgement succeeds", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calledMethods: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const method = String(input).split("/").at(-1)!;
      calledMethods.push(method);
      return method === "editMessageText"
        ? Response.json({ ok: false }, { status: 500 })
        : Response.json({ ok: true, result: true });
    };

    const response = await handleTelegramWebhook(callbackRequest(draftId), workerEnv(), fetcher);

    expect(response.status).toBe(502);
    expect(await draftStatus(draftId)).toBe("approved");
    expect(calledMethods).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "webhook_provider_error", category: "telegram_api_error",
    }));
  });

  it("exposes a POST-only Worker fetch path", async () => {
    const response = await worker.fetch(new Request("https://worker.test/telegram"), workerEnv());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("does not route POST requests outside /telegram", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/not-telegram", { method: "POST" }),
      workerEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("rejects a Telegram health probe without its separate diagnostic secret", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/internal/telegram-health", { method: "POST" }),
      workerEnv(),
    );

    expect(response.status).toBe(401);
  });

  it("rejects a wrong diagnostic secret before probing Telegram", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(
      new Request("https://worker.test/internal/telegram-health", {
        method: "POST",
        headers: { "X-Diagnostic-Secret": "wrong-secret" },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("probes Telegram from the Worker without returning bot details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: true, result: { id: 8702486864, username: "private" } }),
    );
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(
      new Request("https://worker.test/internal/telegram-health", {
        method: "POST",
        headers: { "X-Diagnostic-Secret": DIAGNOSTIC_SECRET },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-test-token/getMe");
  });

  it("redacts a failed Telegram health probe", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretLookingError = "provider details bot123456:secret-token must stay private";
    vi.stubGlobal("fetch", async () => {
      throw new Error(secretLookingError);
    });

    const response = await worker.fetch(
      new Request("https://worker.test/internal/telegram-health", {
        method: "POST",
        headers: { "X-Diagnostic-Secret": DIAGNOSTIC_SECRET },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(502);
    const responseBody = await response.text();
    expect(JSON.parse(responseBody)).toEqual({
      status: "unavailable",
      category: "telegram_network_error",
      transport: "fetch_rejected",
    });
    expect(responseBody).not.toContain(secretLookingError);
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "telegram_health_failed",
      category: "telegram_network_error",
    }));
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(secretLookingError);
  });

  it("classifies an aborted Telegram health probe as a timeout", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("request aborted", "AbortError");
    });

    const response = await worker.fetch(
      new Request("https://worker.test/internal/telegram-health", {
        method: "POST",
        headers: { "X-Diagnostic-Secret": DIAGNOSTIC_SECRET },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: "unavailable",
      category: "telegram_timeout",
      transport: "timeout",
    });
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "telegram_health_failed",
      category: "telegram_timeout",
    }));
  });

  it("classifies a Telegram health response timeout as a timeout", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerResponse = Response.json({ ok: true });
    vi.spyOn(providerResponse, "json").mockRejectedValue(new DOMException("request aborted", "AbortError"));
    vi.stubGlobal("fetch", async () => providerResponse);

    const response = await worker.fetch(
      new Request("https://worker.test/internal/telegram-health", {
        method: "POST",
        headers: { "X-Diagnostic-Secret": DIAGNOSTIC_SECRET },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: "unavailable",
      category: "telegram_timeout",
      transport: "timeout",
    });
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "telegram_health_failed",
      category: "telegram_timeout",
    }));
  });

  it("redacts an arbitrary Telegram health handler error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretLookingError = "telegram_bot_token_secret";
    const fetcher: typeof fetch = async () => ({
      get ok() {
        throw new Error(secretLookingError);
      },
    }) as unknown as Response;

    const response = await handleTelegramHealth(
      new Request("https://worker.test/internal/telegram-health", {
        method: "POST",
        headers: { "X-Diagnostic-Secret": DIAGNOSTIC_SECRET },
      }),
      workerEnv(),
      fetcher,
    );

    expect(response.status).toBe(502);
    const responseBody = await response.text();
    expect(JSON.parse(responseBody)).toEqual({
      status: "unavailable",
      category: "diagnostic_error",
      transport: "fetch_rejected",
    });
    expect(responseBody).not.toContain(secretLookingError);
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "telegram_health_failed",
      category: "diagnostic_error",
    }));
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(secretLookingError);
  });
});
