import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../../supabase/functions/_shared/telegram";

const TELEGRAM_CONFIG = {
  botToken: "test-token",
  chatId: "1331364954",
};

describe("direct Telegram client", () => {
  it("calls Telegram directly for getMe", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: {
        id: 8702486864,
        is_bot: true,
        first_name: "Football News Approval Bot",
        username: "football_news_approval_bot",
      },
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await client.checkHealth();

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bottest-token/getMe");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends one labelled diagnostic message to the configured chat", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: {
        message_id: 77,
        date: 1_786_357_502,
        text: "Supabase Telegram diagnostic succeeded.",
        chat: { id: 1_331_364_954, type: "private" },
      },
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await expect(client.sendDiagnostic()).resolves.toBe(77);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "1331364954",
      text: "Supabase Telegram diagnostic succeeded.",
    });
  });

  it("answers the controlled webhook callback without a relay", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: true,
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await client.answerCallback(
      "callback-query-1",
      "Supabase webhook received.",
    );

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.telegram.org/bottest-token/answerCallbackQuery",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      callback_query_id: "callback-query-1",
      text: "Supabase webhook received.",
    });
  });

  it("sends a reviewable draft with compact approve and reject callbacks", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: { message_id: 314 },
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await expect(client.sendDraft({
      id: 42,
      body: "Club confirms the transfer.",
      canonicalUrl: "https://club.test/news/transfer",
    })).resolves.toBe(314);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "1331364954",
      text: "Club confirms the transfer.\n\nSource: https://club.test/news/transfer",
      reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: "a:42" },
          { text: "Reject", callback_data: "r:42" },
        ]],
      },
    });
  });

  it("sends the current X posting mode with manual available and auto locked", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: { message_id: 500 },
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await expect(client.sendXPostingModePanel("off")).resolves.toBe(500);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "1331364954",
      text: "X posting mode: OFF",
      reply_markup: {
        inline_keyboard: [[
          { text: "OFF ✓", callback_data: "xm:off" },
          { text: "MANUAL", callback_data: "xm:manual" },
          { text: "AUTO 🔒", callback_data: "xm:auto" },
        ]],
      },
    });
  });

  it("refreshes an existing X posting mode panel", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: true,
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await client.editXPostingModePanel(500, "manual");

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.telegram.org/bottest-token/editMessageText",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "1331364954",
      message_id: 500,
      text: "X posting mode: MANUAL",
      reply_markup: {
        inline_keyboard: [[
          { text: "OFF", callback_data: "xm:off" },
          { text: "MANUAL ✓", callback_data: "xm:manual" },
          { text: "AUTO 🔒", callback_data: "xm:auto" },
        ]],
      },
    });
  });

  it("edits a delivered draft to a bounded terminal state without buttons", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: true,
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await client.editDraftState(
      314,
      `${"x".repeat(4_096)}\n\nSource: https://club.test/news/transfer`,
      "approved",
    );

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.telegram.org/bottest-token/editMessageText",
    );
    const payload = JSON.parse(String(init?.body)) as {
      chat_id: string;
      message_id: number;
      text: string;
      reply_markup: unknown;
    };
    expect(payload.chat_id).toBe("1331364954");
    expect(payload.message_id).toBe(314);
    expect(payload.text).toHaveLength(4_096);
    expect(payload.text).toMatch(/\n\nStatus: APPROVED$/u);
    expect(payload.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("replaces decision controls with an encoded Open in X URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: true,
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);
    const xPostText = "📰 NEWS: Club & player agree.\nVia BBC Sport Football";

    await client.editDraftState(
      314,
      `${xPostText}\n\nSource: https://club.test/news/transfer`,
      "approved",
      xPostText,
    );

    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; url: string }>>;
      };
    };
    const button = payload.reply_markup.inline_keyboard[0]?.[0];
    expect(button?.text).toBe("Open in X");
    const intent = new URL(button?.url ?? "");
    expect(intent.origin).toBe("https://x.com");
    expect(intent.pathname).toBe("/intent/tweet");
    expect(intent.searchParams.get("text")).toBe(xPostText);
    expect(button?.url).not.toContain("club.test");
  });

  it("never offers Open in X for a rejected draft", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: true,
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await client.editDraftState(
      314,
      "Rejected draft.\n\nSource: https://club.test/news/transfer",
      "rejected",
      "Rejected draft.",
    );

    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      reply_markup: unknown;
    };
    expect(payload.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("reads only the safe webhook routing fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: {
        url: "https://old.example/telegram",
        has_custom_certificate: false,
        pending_update_count: 2,
        last_error_message: "provider detail must not escape",
      },
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await expect(client.getWebhookInfo()).resolves.toEqual({
      url: "https://old.example/telegram",
      pendingUpdateCount: 2,
    });
  });

  it("configures the direct webhook for commands and callback queries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: true,
    }));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await client.setWebhook(
      "https://project.supabase.co/functions/v1/telegram-webhook",
      "webhook-test-secret",
    );

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.telegram.org/bottest-token/setWebhook",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://project.supabase.co/functions/v1/telegram-webhook",
      secret_token: "webhook-test-secret",
      allowed_updates: ["message", "callback_query"],
    });
  });

  it("reports a sanitized API category without Telegram response text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { ok: false, error_code: 401, description: "secret provider detail" },
      { status: 401 },
    ));
    const client = new TelegramClient(TELEGRAM_CONFIG, fetcher);

    await expect(client.checkHealth()).rejects.toThrow("telegram_api_error:401");
    await expect(client.checkHealth()).rejects.not.toThrow("secret provider detail");
  });
});
