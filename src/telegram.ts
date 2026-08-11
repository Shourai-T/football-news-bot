import { MAX_DRAFT_BODY_LENGTH } from "./limits";
import type { DraftStatus, TelegramConfig, TelegramDraft } from "./types";

const REQUEST_TIMEOUT_MS = 8_000;
const TELEGRAM_TEXT_LIMIT = 4_096;
const SOURCE_PREFIX = "\n\nSource: ";

interface TelegramResponse {
  ok?: unknown;
  result?: unknown;
}

interface RelayResponse {
  ok: boolean;
  status?: number;
  body?: string;
}

interface RelayResponseWithBody extends RelayResponse {
  status: number;
  body: string;
}

class TelegramRelayRedirectError extends Error {
  constructor() {
    super("telegram_relay_redirect_error");
  }
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
  constructor(
    private readonly config: TelegramConfig,
    private readonly fetcher: typeof fetch,
  ) {
    if (isTelegramApiUrl(config.relayUrl)) {
      throw new Error("telegram_relay_configuration_error");
    }
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
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      response = await this.fetcher(this.config.relayUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: this.config.relaySecret,
          chatId: this.config.chatId,
          method,
          body,
        }),
        redirect: "manual",
        signal,
      });
      response = await followAppsScriptRedirect(response, this.fetcher, signal);
    } catch (error) {
      if (error instanceof TelegramRelayRedirectError) {
        throw error;
      }
      const timeout = isTimeout(error);
      throw new TelegramRequestError(
        timeout ? "telegram_timeout" : "telegram_network_error",
        timeout ? "timeout" : "fetch_rejected",
      );
    }

    if (!response.ok) {
      throw new Error("telegram_relay_error");
    }

    let relayPayload: unknown;
    try {
      relayPayload = (await response.json()) as RelayResponse;
    } catch (error) {
      if (isTimeout(error)) {
        throw new TelegramRequestError("telegram_timeout", "timeout");
      }
      throw new Error("telegram_invalid_response");
    }
    if (!isRelayResponse(relayPayload)) {
      throw new Error("telegram_invalid_response");
    }
    if (!hasRelayResponseBody(relayPayload)) {
      throw new Error(relayPayload.ok ? "telegram_invalid_response" : "telegram_relay_error");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(relayPayload.body);
    } catch {
      throw new Error(relayPayload.ok ? "telegram_invalid_response" : "telegram_relay_error");
    }
    if (!isTelegramResponse(payload)) {
      throw new Error(relayPayload.ok ? "telegram_invalid_response" : "telegram_relay_error");
    }
    if (relayPayload.ok !== true) {
      throw new Error(payload.ok === false ? `telegram_api_error:${relayPayload.status}` : "telegram_relay_error");
    }
    if (payload.ok !== true) {
      throw new Error(`telegram_api_error:${relayPayload.status}`);
    }

    return payload;
  }
}

async function followAppsScriptRedirect(
  response: Response,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  if (!isRedirectStatus(response.status)) {
    if (response.status >= 300 && response.status < 400) {
      throw new TelegramRelayRedirectError();
    }
    return response;
  }

  const location = response.headers.get("location");
  if (location === null || !isAllowedAppsScriptRedirect(location)) {
    throw new TelegramRelayRedirectError();
  }

  return fetcher(location, {
    method: "GET",
    redirect: "error",
    signal,
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 302 || status === 303;
}

function isAllowedAppsScriptRedirect(location: string): boolean {
  try {
    const url = new URL(location);
    return url.protocol === "https:" &&
      url.hostname === "script.googleusercontent.com" &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
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

function isRelayResponse(value: unknown): value is RelayResponse {
  return isRecord(value) &&
    typeof value.ok === "boolean" &&
    (value.status === undefined || (typeof value.status === "number" && Number.isInteger(value.status))) &&
    (value.body === undefined || typeof value.body === "string");
}

function hasRelayResponseBody(value: RelayResponse): value is RelayResponseWithBody {
  return typeof value.status === "number" && typeof value.body === "string";
}

function isTelegramResponse(value: unknown): value is TelegramResponse & { ok: boolean } {
  return isRecord(value) && typeof value.ok === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTelegramApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.replace(/\.$/, "") === "api.telegram.org";
  } catch {
    return false;
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
