const REQUEST_TIMEOUT_MS = 8_000;
const TELEGRAM_API_ROOT = "https://api.telegram.org";
const DIAGNOSTIC_TEXT = "Supabase Telegram diagnostic succeeded.";
const WEBHOOK_PROBE_TEXT =
  "Tap the button to verify Telegram → Supabase webhook delivery.";

export interface DirectTelegramConfig {
  botToken: string;
  chatId: string;
}

export interface TelegramWebhookInfo {
  url: string;
  pendingUpdateCount: number;
}

interface TelegramResponse {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
}

export class TelegramClient {
  constructor(
    private readonly config: DirectTelegramConfig,
    private readonly fetcher: typeof fetch,
  ) {}

  async checkHealth(): Promise<void> {
    await this.request("getMe", {});
  }

  async sendDiagnostic(): Promise<number> {
    const response = await this.request("sendMessage", {
      chat_id: this.config.chatId,
      text: DIAGNOSTIC_TEXT,
    });
    const messageId = getMessageId(response.result);
    if (messageId === null) {
      throw new Error("telegram_invalid_response");
    }
    return messageId;
  }

  async sendWebhookProbe(): Promise<number> {
    const response = await this.request("sendMessage", {
      chat_id: this.config.chatId,
      text: WEBHOOK_PROBE_TEXT,
      reply_markup: {
        inline_keyboard: [[{
          text: "Test Supabase webhook",
          callback_data: "v:1",
        }]],
      },
    });
    const messageId = getMessageId(response.result);
    if (messageId === null) {
      throw new Error("telegram_invalid_response");
    }
    return messageId;
  }

  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    const response = await this.request("getWebhookInfo", {});
    const info = parseWebhookInfo(response.result);
    if (info === null) {
      throw new Error("telegram_invalid_response");
    }
    return info;
  }

  async setWebhook(webhookUrl: string, webhookSecret: string): Promise<void> {
    await this.request("setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["callback_query"],
    });
  }

  private async request(
    method: string,
    body: Record<string, unknown>,
  ): Promise<TelegramResponse & { ok: boolean }> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${TELEGRAM_API_ROOT}/bot${this.config.botToken}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new Error(isTimeout(error) ? "telegram_timeout" : "telegram_network_error");
    }

    if (!response.ok) {
      throw new Error(`telegram_api_error:${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(isTimeout(error) ? "telegram_timeout" : "telegram_invalid_response");
    }
    if (!isTelegramResponse(payload)) {
      throw new Error("telegram_invalid_response");
    }
    if (!payload.ok) {
      const status = typeof payload.error_code === "number" && Number.isInteger(payload.error_code)
        ? payload.error_code
        : response.status;
      throw new Error(`telegram_api_error:${status}`);
    }
    return payload;
  }
}

function isTelegramResponse(
  value: unknown,
): value is TelegramResponse & { ok: boolean } {
  return typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean";
}

function getMessageId(value: unknown): number | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("message_id" in value) ||
    typeof value.message_id !== "number" ||
    !Number.isSafeInteger(value.message_id)
  ) {
    return null;
  }
  return value.message_id;
}

function parseWebhookInfo(value: unknown): TelegramWebhookInfo | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("pending_update_count" in value) ||
    typeof value.pending_update_count !== "number" ||
    !Number.isSafeInteger(value.pending_update_count) ||
    value.pending_update_count < 0
  ) {
    return null;
  }
  return {
    url: value.url,
    pendingUpdateCount: value.pending_update_count,
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}
