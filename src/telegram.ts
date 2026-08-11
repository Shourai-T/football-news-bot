import { MAX_DRAFT_BODY_LENGTH } from "./limits";
import type { DraftStatus, TelegramConfig, TelegramDraft } from "./types";

const REQUEST_TIMEOUT_MS = 8_000;
const TELEGRAM_TEXT_LIMIT = 4_096;
const SOURCE_PREFIX = "\n\nSource: ";

interface TelegramResponse {
  ok?: unknown;
  result?: unknown;
}

export class TelegramRequestError extends Error {
  constructor(
    message: "telegram_timeout" | "telegram_network_error",
    readonly transport: "timeout" | "fetch_rejected",
  ) {
    super(message);
  }
}

export class TelegramClient {
  readonly #baseUrl: string;

  constructor(
    private readonly config: TelegramConfig,
    private readonly fetcher: typeof fetch,
  ) {
    this.#baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  }

  async sendDraft(draft: TelegramDraft): Promise<number> {
    const payload = await this.#request("sendMessage", {
      chat_id: this.config.chatId,
      text: formatDraft(draft),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `a:${draft.id}` },
            { text: "Reject", callback_data: `r:${draft.id}` },
          ],
        ],
      },
    });
    const messageId = getMessageId(payload.result);
    if (messageId === null) {
      throw new Error("telegram_invalid_response");
    }

    return messageId;
  }

  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await this.#request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async checkHealth(): Promise<void> {
    await this.#request("getMe", {});
  }

  async editDraftState(
    telegramMessageId: number,
    currentText: string,
    status: Exclude<DraftStatus, "pending">,
  ): Promise<void> {
    await this.#request("editMessageText", {
      chat_id: this.config.chatId,
      message_id: telegramMessageId,
      text: truncate(currentText, TELEGRAM_TEXT_LIMIT - statusSuffix(status).length) + statusSuffix(status),
      reply_markup: { inline_keyboard: [] },
    });
  }

  async #request(method: string, body: Record<string, unknown>): Promise<TelegramResponse> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.#baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = isTimeout(error);
      throw new TelegramRequestError(
        timeout ? "telegram_timeout" : "telegram_network_error",
        timeout ? "timeout" : "fetch_rejected",
      );
    }

    if (!response.ok) {
      throw new Error(`telegram_api_error:${response.status}`);
    }

    let payload: TelegramResponse;
    try {
      payload = (await response.json()) as TelegramResponse;
    } catch (error) {
      if (isTimeout(error)) {
        throw new TelegramRequestError("telegram_timeout", "timeout");
      }
      throw new Error("telegram_invalid_response");
    }
    if (payload.ok !== true) {
      throw new Error(`telegram_api_error:${response.status}`);
    }

    return payload;
  }
}

function formatDraft(draft: TelegramDraft): string {
  const body = truncate(draft.body, MAX_DRAFT_BODY_LENGTH);
  const sourceLength = TELEGRAM_TEXT_LIMIT - body.length - SOURCE_PREFIX.length;
  return `${body}${SOURCE_PREFIX}${truncate(draft.canonicalUrl, sourceLength)}`;
}

function statusSuffix(status: Exclude<DraftStatus, "pending">): string {
  return `\n\nStatus: ${status.toUpperCase()}`;
}

function truncate(value: string, maximumLength: number): string {
  return value.slice(0, Math.max(0, maximumLength));
}

function getMessageId(result: unknown): number | null {
  if (typeof result !== "object" || result === null || !("message_id" in result)) {
    return null;
  }

  const messageId = result.message_id;
  return typeof messageId === "number" && Number.isInteger(messageId) ? messageId : null;
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
