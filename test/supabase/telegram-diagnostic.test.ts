import { describe, expect, it, vi } from "vitest";
import { createTelegramDiagnosticHandler } from "../../supabase/functions/telegram-diagnostic/handler";

const ENV = new Map([
  ["TELEGRAM_BOT_TOKEN", "test-token"],
  ["TELEGRAM_CHAT_ID", "1331364954"],
  ["TELEGRAM_WEBHOOK_SECRET", "webhook-test-secret"],
  ["SCHEDULED_FUNCTION_SECRET", "scheduled-test-secret"],
  ["SUPABASE_URL", "https://project.supabase.co"],
]);

function request(
  operation:
    | "getMe"
    | "sendMessage"
    | "getWebhookInfo"
    | "setWebhook",
  secret = "scheduled-test-secret",
  url = "https://project.supabase.co/functions/v1/telegram-diagnostic",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Scheduled-Secret": secret,
    },
    body: JSON.stringify({ operation }),
  });
}

describe("Telegram diagnostic handler", () => {
  it("rejects an invalid operator secret before calling Telegram", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createTelegramDiagnosticHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(request("getMe", "wrong-secret"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ status: "unauthorized" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns generic getMe success without exposing Telegram data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: {
        id: 8702486864,
        is_bot: true,
        first_name: "Football News Approval Bot",
        username: "football_news_approval_bot",
      },
    }));
    const handler = createTelegramDiagnosticHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(request("getMe"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ status: "ok", operation: "getMe" });
    expect(body).not.toContain("test-token");
    expect(body).not.toContain("8702486864");
  });

  it("sends a diagnostic message without returning its message identifier", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: {
        message_id: 77,
        date: 1_786_357_502,
        text: "Supabase Telegram diagnostic succeeded.",
        chat: { id: 1_331_364_954, type: "private" },
      },
    }));
    const handler = createTelegramDiagnosticHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(request("sendMessage"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      operation: "sendMessage",
    });
  });

  it("returns only safe webhook routing fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: {
        url: "https://old.example/telegram",
        has_custom_certificate: false,
        pending_update_count: 2,
        last_error_message: "provider detail must not escape",
      },
    }));
    const handler = createTelegramDiagnosticHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(request("getWebhookInfo"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      operation: "getWebhookInfo",
      webhook: {
        url: "https://old.example/telegram",
        pendingUpdateCount: 2,
      },
    });
  });

  it("sets only the sibling Supabase webhook URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: true,
      result: true,
    }));
    const handler = createTelegramDiagnosticHandler({
      readEnv: (name) => ENV.get(name),
      fetcher,
    });

    const response = await handler(request(
      "setWebhook",
      "scheduled-test-secret",
      "http://internal-runtime/telegram-diagnostic",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      operation: "setWebhook",
    });
    const [, init] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://project.supabase.co/functions/v1/telegram-webhook",
      secret_token: "webhook-test-secret",
      allowed_updates: ["message", "callback_query"],
    });
  });
});
