import type { DraftDecision, DraftStatus } from "../_shared/domain-types.ts";
import {
  readRequiredEnv,
  type RuntimeEnvReader,
} from "../_shared/runtime-env.ts";
import type { BotRepository } from "../_shared/repository.ts";
import { TelegramClient } from "../_shared/telegram.ts";

export interface TelegramWebhookDependencies {
  readEnv: RuntimeEnvReader;
  fetcher: typeof fetch;
  repository: BotRepository;
}

interface ParsedCallback {
  id: string;
  data: string;
  chatId: string;
  messageId: number;
}

export function createTelegramWebhookHandler(
  dependencies: TelegramWebhookDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json({ status: "method_not_allowed" }, { status: 405 });
    }

    let webhookSecret: string;
    try {
      webhookSecret = readRequiredEnv(
        "TELEGRAM_WEBHOOK_SECRET",
        dependencies.readEnv,
      );
    } catch {
      return Response.json({ status: "misconfigured" }, { status: 500 });
    }

    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== webhookSecret
    ) {
      return Response.json({ status: "unauthorized" }, { status: 401 });
    }

    let botToken: string;
    let configuredChatId: string;
    try {
      botToken = readRequiredEnv("TELEGRAM_BOT_TOKEN", dependencies.readEnv);
      configuredChatId = readRequiredEnv("TELEGRAM_CHAT_ID", dependencies.readEnv);
    } catch {
      return Response.json({ status: "misconfigured" }, { status: 500 });
    }

    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return Response.json({ status: "bad_request" }, { status: 400 });
    }
    if (!isRecord(update) || !("callback_query" in update)) {
      return Response.json({ status: "ignored" });
    }

    const callback = parseCallback(update.callback_query);
    if (callback === null) {
      return Response.json({ status: "bad_request" }, { status: 400 });
    }
    if (callback.chatId !== configuredChatId) {
      return Response.json({ status: "forbidden" }, { status: 403 });
    }

    const action = /^(a|r):([1-9]\d*)$/u.exec(callback.data);
    const draftId = action ? Number(action[2]) : Number.NaN;
    if (!action || !Number.isSafeInteger(draftId)) {
      return Response.json({ status: "bad_request" }, { status: 400 });
    }

    let stored;
    try {
      stored = await dependencies.repository.getDraftForCallback(draftId);
    } catch {
      return Response.json({ status: "database_error" }, { status: 500 });
    }
    if (stored === null || stored.telegramMessageId === null) {
      return Response.json({ status: "ignored" });
    }
    if (stored.telegramMessageId !== callback.messageId) {
      return Response.json({ status: "forbidden" }, { status: 403 });
    }

    const decision: DraftDecision = action[1] === "a" ? "approved" : "rejected";
    const wasPending = stored.status === "pending";
    let status: DraftStatus | null = stored.status;
    if (wasPending) {
      try {
        status = await dependencies.repository.transitionDraft(
          draftId,
          decision,
          new Date(),
        );
      } catch {
        return Response.json({ status: "database_error" }, { status: 500 });
      }
    }
    if (status === null || status === "pending") {
      return Response.json({ status: "ignored" });
    }

    const changed = wasPending && status === decision;
    const telegram = new TelegramClient(
      { botToken, chatId: configuredChatId },
      dependencies.fetcher,
    );
    let providerFailed = false;
    try {
      await telegram.answerCallback(
        callback.id,
        changed ? capitalize(status) : `Already ${status}`,
      );
    } catch {
      providerFailed = true;
    }
    try {
      await telegram.editDraftState(
        stored.telegramMessageId,
        `${stored.body}\n\nSource: ${stored.canonicalUrl}`,
        status,
      );
    } catch {
      providerFailed = true;
    }

    return providerFailed
      ? Response.json({ status: "provider_error" }, { status: 502 })
      : Response.json({ status: "ok", decision: status });
  };
}

function parseCallback(value: unknown): ParsedCallback | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.data !== "string" ||
    !isRecord(value.message) ||
    !isRecord(value.message.chat)
  ) {
    return null;
  }
  const chatId = value.message.chat.id;
  const messageId = value.message.message_id;
  if (
    ((typeof chatId !== "number" || !Number.isSafeInteger(chatId)) &&
      typeof chatId !== "string") ||
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId)
  ) {
    return null;
  }
  return {
    id: value.id,
    data: value.data,
    chatId: String(chatId),
    messageId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
