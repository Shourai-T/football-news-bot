import { describe, expect, it, vi } from "vitest";
import { createTelegramWebhookViabilityHandler } from "../../supabase/functions/telegram-webhook/viability-handler";

const ENV = new Map([
  ["TELEGRAM_BOT_TOKEN", "test-token"],
  ["TELEGRAM_CHAT_ID", "1331364954"],
  ["TELEGRAM_WEBHOOK_SECRET", "webhook-test-secret"],
]);

function callbackRequest(options: {
  secret?: string;
  chatId?: number;
  data?: string;
} = {}): Request {
  return new Request(
    "https://project.supabase.co/functions/v1/telegram-webhook",
    {
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
          data: options.data ?? "v:1",
          message: {
            message_id: 78,
            date: 1_786_357_502,
            chat: {
              id: options.chatId ?? 1_331_364_954,
              type: "private",
            },
          },
        },
      }),
    },
  );
}

describe("Telegram webhook viability handler", () => {
  it("rejects an invalid webhook secret before calling Telegram", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createTelegramWebhookViabilityHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(callbackRequest({ secret: "wrong-secret" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ status: "unauthorized" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects callbacks from a foreign chat before calling Telegram", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createTelegramWebhookViabilityHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(callbackRequest({ chatId: 999 }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ status: "forbidden" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects callback data outside the controlled viability probe", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createTelegramWebhookViabilityHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(callbackRequest({ data: "a:123" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ status: "bad_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("acknowledges the controlled callback through Telegram directly", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: true,
    }));
    const handler = createTelegramWebhookViabilityHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(callbackRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      operation: "webhookProbe",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.telegram.org/bottest-token/answerCallbackQuery",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      callback_query_id: "callback-query-1",
      text: "Supabase webhook received.",
    });
  });
});
