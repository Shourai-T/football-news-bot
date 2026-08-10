import type { DraftStatus, TelegramConfig, TelegramDraft } from "./types";

const REQUEST_TIMEOUT_MS = 8_000;

interface TelegramResponse {
  ok?: unknown;
  result?: unknown;
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

  async editDraftState(
    telegramMessageId: number,
    currentText: string,
    status: Exclude<DraftStatus, "pending">,
  ): Promise<void> {
    await this.#request("editMessageText", {
      chat_id: this.config.chatId,
      message_id: telegramMessageId,
      text: `${currentText}\n\nStatus: ${status.toUpperCase()}`,
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
      throw new Error(isTimeout(error) ? "telegram_timeout" : "telegram_network_error");
    }

    if (!response.ok) {
      throw new Error(`telegram_api_error:${response.status}`);
    }

    let payload: TelegramResponse;
    try {
      payload = (await response.json()) as TelegramResponse;
    } catch (error) {
      throw new Error(isTimeout(error) ? "telegram_timeout" : "telegram_invalid_response");
    }
    if (payload.ok !== true) {
      throw new Error(`telegram_api_error:${response.status}`);
    }

    return payload;
  }
}

function formatDraft(draft: TelegramDraft): string {
  return `${draft.body}\n\nSource: ${draft.canonicalUrl}`;
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
