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
