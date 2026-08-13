import {
  readRequiredEnv,
  type RuntimeEnvReader,
} from "../_shared/runtime-env.ts";
import { TelegramClient } from "../_shared/telegram.ts";

const WEBHOOK_PROBE_CALLBACK = "v:1";
const WEBHOOK_PROBE_ACKNOWLEDGEMENT = "Supabase webhook received.";

export interface TelegramWebhookViabilityDependencies {
  readEnv: RuntimeEnvReader;
  fetcher: typeof fetch;
}

interface ViabilityCallback {
  callbackQueryId: string;
  chatId: string;
}

export function createTelegramWebhookViabilityHandler(
  dependencies: TelegramWebhookViabilityDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json({ status: "method_not_allowed" }, { status: 405 });
    }

    let webhookSecret: string;
    let chatId: string;
    let botToken: string;
    try {
      webhookSecret = readRequiredEnv(
        "TELEGRAM_WEBHOOK_SECRET",
        dependencies.readEnv,
      );
      chatId = readRequiredEnv("TELEGRAM_CHAT_ID", dependencies.readEnv);
      botToken = readRequiredEnv("TELEGRAM_BOT_TOKEN", dependencies.readEnv);
    } catch {
      return Response.json({ status: "misconfigured" }, { status: 500 });
    }

    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== webhookSecret
    ) {
      return Response.json({ status: "unauthorized" }, { status: 401 });
    }

    let callback: ViabilityCallback | null;
    try {
      callback = parseViabilityCallback(await request.json());
    } catch {
      callback = null;
    }
    if (callback === null) {
      return Response.json({ status: "bad_request" }, { status: 400 });
    }
    if (callback.chatId !== chatId) {
      return Response.json({ status: "forbidden" }, { status: 403 });
    }

    const telegram = new TelegramClient(
      { botToken, chatId },
      dependencies.fetcher,
    );
    try {
      await telegram.answerCallback(
        callback.callbackQueryId,
        WEBHOOK_PROBE_ACKNOWLEDGEMENT,
      );
      return Response.json({ status: "ok", operation: "webhookProbe" });
    } catch (error) {
      return Response.json(
        { status: "unavailable", category: errorCategory(error) },
        { status: 502 },
      );
    }
  };
}

function parseViabilityCallback(value: unknown): ViabilityCallback | null {
  if (!isRecord(value) || !isRecord(value.callback_query)) return null;
  const callback = value.callback_query;
  if (
    typeof callback.id !== "string" ||
    callback.id.length === 0 ||
    callback.data !== WEBHOOK_PROBE_CALLBACK ||
    !isRecord(callback.message) ||
    !isRecord(callback.message.chat)
  ) {
    return null;
  }

  const chatId = callback.message.chat.id;
  if (
    (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) &&
    typeof chatId !== "string"
  ) {
    return null;
  }

  return {
    callbackQueryId: callback.id,
    chatId: String(chatId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "telegram_error";
  const category = error.message.split(":", 1)[0];
  return /^[a-z][a-z0-9_]{0,63}$/.test(category)
    ? category
    : "telegram_error";
}
