import type {
  DraftStatus,
  TelegramDraft,
  XPostingMode,
} from "./domain-types.ts";
import { MAX_DRAFT_BODY_LENGTH } from "./limits.ts";

const REQUEST_TIMEOUT_MS = 8_000;
const TELEGRAM_API_ROOT = "https://api.telegram.org";
const DIAGNOSTIC_TEXT = "Supabase Telegram diagnostic succeeded.";
const TELEGRAM_TEXT_LIMIT = 4_096;
const SOURCE_PREFIX = "\n\nSource: ";

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

  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async sendDraft(draft: TelegramDraft): Promise<number> {
    const response = await this.request("sendMessage", {
      chat_id: this.config.chatId,
      text: formatDraft(draft),
      reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: `a:${draft.id}` },
          { text: "Reject", callback_data: `r:${draft.id}` },
        ]],
      },
    });
    const messageId = getMessageId(response.result);
    if (messageId === null) throw new Error("telegram_invalid_response");
    return messageId;
  }

  async sendXPostingModePanel(mode: XPostingMode): Promise<number> {
    const response = await this.request("sendMessage", {
      chat_id: this.config.chatId,
      ...xPostingModePanel(mode),
    });
    const messageId = getMessageId(response.result);
    if (messageId === null) throw new Error("telegram_invalid_response");
    return messageId;
  }

  async editXPostingModePanel(
    messageId: number,
    mode: XPostingMode,
  ): Promise<void> {
    await this.request("editMessageText", {
      chat_id: this.config.chatId,
      message_id: messageId,
      ...xPostingModePanel(mode),
    });
  }

  async editDraftState(
    telegramMessageId: number,
    currentText: string,
    status: Exclude<DraftStatus, "pending">,
  ): Promise<void> {
    const suffix = `\n\nStatus: ${status.toUpperCase()}`;
    await this.request("editMessageText", {
      chat_id: this.config.chatId,
      message_id: telegramMessageId,
      text: truncate(currentText, TELEGRAM_TEXT_LIMIT - suffix.length) + suffix,
      reply_markup: { inline_keyboard: [] },
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
      allowed_updates: ["message", "callback_query"],
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

function formatDraft(draft: TelegramDraft): string {
  const body = truncate(draft.body, MAX_DRAFT_BODY_LENGTH);
  const sourceLength = TELEGRAM_TEXT_LIMIT - body.length - SOURCE_PREFIX.length;
  return `${body}${SOURCE_PREFIX}${truncate(draft.canonicalUrl, sourceLength)}`;
}

function xPostingModePanel(mode: XPostingMode): Record<string, unknown> {
  return {
    text: `X posting mode: ${mode.toUpperCase()}`,
    reply_markup: {
      inline_keyboard: [[
        {
          text: mode === "off" ? "OFF ✓" : "OFF",
          callback_data: "xm:off",
        },
        { text: "MANUAL 🔒", callback_data: "xm:manual" },
        { text: "AUTO 🔒", callback_data: "xm:auto" },
      ]],
    },
  };
}

function truncate(value: string, maximumLength: number): string {
  return value.slice(0, Math.max(0, maximumLength));
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}
