import type { DraftDecision, DraftStatus } from "../_shared/domain-types.ts";
import {
  readRequiredEnv,
  type RuntimeEnvReader,
} from "../_shared/runtime-env.ts";
import type {
  BotRepository,
  XPostingModeRepository,
} from "../_shared/repository.ts";
import { TelegramClient } from "../_shared/telegram.ts";

export interface TelegramWebhookDependencies {
  readEnv: RuntimeEnvReader;
  fetcher: typeof fetch;
  repository: BotRepository & XPostingModeRepository;
  now?: () => Date;
}

interface ParsedCallback {
  id: string;
  data: string;
  chatId: string;
  messageId: number;
}

interface ParsedMessage {
  chatId: string;
  text: string;
}

export function createTelegramWebhookHandler(
  dependencies: TelegramWebhookDependencies,
): (request: Request) => Promise<Response> {
  const now = dependencies.now ?? (() => new Date());
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

    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return Response.json({ status: "bad_request" }, { status: 400 });
    }
    if (!isRecord(update) || !("callback_query" in update)) {
      if (!isRecord(update) || !("message" in update)) {
        return Response.json({ status: "ignored" });
      }
      const message = parseMessage(update.message);
      if (message === null) {
        return Response.json({ status: "bad_request" }, { status: 400 });
      }
      let botToken: string;
      let configuredChatId: string;
      try {
        botToken = readRequiredEnv("TELEGRAM_BOT_TOKEN", dependencies.readEnv);
        configuredChatId = readRequiredEnv(
          "TELEGRAM_CHAT_ID",
          dependencies.readEnv,
        );
      } catch {
        return Response.json({ status: "misconfigured" }, { status: 500 });
      }
      if (message.chatId !== configuredChatId) {
        return Response.json({ status: "forbidden" }, { status: 403 });
      }
      if (!isXModeCommand(message.text)) {
        return Response.json({ status: "ignored" });
      }
      let mode;
      try {
        mode = await dependencies.repository.getXPostingMode();
      } catch {
        return Response.json({ status: "database_error" }, { status: 500 });
      }
      const telegram = new TelegramClient(
        { botToken, chatId: configuredChatId },
        dependencies.fetcher,
      );
      try {
        await telegram.sendXPostingModePanel(mode);
      } catch {
        return Response.json({ status: "provider_error" }, { status: 502 });
      }
      return Response.json({ status: "ok", mode });
    }

    let botToken: string;
    let configuredChatId: string;
    try {
      botToken = readRequiredEnv("TELEGRAM_BOT_TOKEN", dependencies.readEnv);
      configuredChatId = readRequiredEnv("TELEGRAM_CHAT_ID", dependencies.readEnv);
    } catch {
      return Response.json({ status: "misconfigured" }, { status: 500 });
    }

    const callback = parseCallback(update.callback_query);
    if (callback === null) {
      return Response.json({ status: "bad_request" }, { status: 400 });
    }
    if (callback.chatId !== configuredChatId) {
      return Response.json({ status: "forbidden" }, { status: 403 });
    }

    const telegram = new TelegramClient(
      { botToken, chatId: configuredChatId },
      dependencies.fetcher,
    );
    if (callback.data === "xm:manual") {
      try {
        await telegram.answerCallback(
          callback.id,
          "Manual mode is coming soon",
        );
      } catch {
        return Response.json({ status: "provider_error" }, { status: 502 });
      }
      return Response.json({ status: "locked", mode: "manual" });
    }
    if (callback.data === "xm:auto") {
      try {
        await telegram.answerCallback(
          callback.id,
          "Auto mode is not configured",
        );
      } catch {
        return Response.json({ status: "provider_error" }, { status: 502 });
      }
      return Response.json({ status: "locked", mode: "auto" });
    }
    if (callback.data === "xm:off") {
      let currentMode;
      try {
        currentMode = await dependencies.repository.getXPostingMode();
      } catch {
        return Response.json({ status: "database_error" }, { status: 500 });
      }
      if (currentMode === "off") {
        try {
          await telegram.answerCallback(callback.id, "Already OFF");
        } catch {
          return Response.json({ status: "provider_error" }, { status: 502 });
        }
        return Response.json({ status: "ok", mode: "off" });
      }
      try {
        await dependencies.repository.setXPostingMode("off", now());
      } catch {
        return Response.json({ status: "database_error" }, { status: 500 });
      }
      try {
        await telegram.answerCallback(
          callback.id,
          "X posting mode set to OFF",
        );
        await telegram.editXPostingModePanel(callback.messageId, "off");
      } catch {
        return Response.json({ status: "provider_error" }, { status: 502 });
      }
      return Response.json({ status: "ok", mode: "off" });
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

function parseMessage(value: unknown): ParsedMessage | null {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    !isRecord(value.chat)
  ) {
    return null;
  }
  const chatId = value.chat.id;
  if (
    (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) &&
    typeof chatId !== "string"
  ) {
    return null;
  }
  return { chatId: String(chatId), text: value.text };
}

function isXModeCommand(text: string): boolean {
  return /^\/xmode(?:@[A-Za-z0-9_]{5,32})?$/u.test(text.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
