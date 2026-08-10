import { transitionDraft } from "./repository";
import { TelegramClient } from "./telegram";
import type { DraftDecision, DraftStatus, Env } from "./types";

interface StoredDraft {
  body: string;
  canonical_url: string;
  status: DraftStatus;
  telegram_message_id: number | null;
}

interface CallbackQuery {
  id: string;
  data: string;
  chatId: string;
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  fetcher: typeof fetch,
): Promise<Response> {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (!isRecord(update) || !("callback_query" in update)) {
    return new Response("Ignored", { status: 200 });
  }

  const callback = parseCallbackQuery(update.callback_query);
  if (!callback) {
    return new Response("Bad request", { status: 400 });
  }
  if (callback.chatId !== env.TELEGRAM_CHAT_ID) {
    return new Response("Forbidden", { status: 403 });
  }

  const match = /^(a|r):([1-9]\d*)$/.exec(callback.data);
  const draftId = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(draftId)) {
    return new Response("Bad request", { status: 400 });
  }

  const stored = await env.DB
    .prepare(
      `SELECT drafts.body, drafts.status, drafts.telegram_message_id, articles.canonical_url
       FROM drafts
       JOIN articles ON articles.id = drafts.article_id
       WHERE drafts.id = ?`,
    )
    .bind(draftId)
    .first<StoredDraft>();
  if (!stored || stored.telegram_message_id === null) {
    return new Response("Ignored", { status: 200 });
  }

  const decision: DraftDecision = match[1] === "a" ? "approved" : "rejected";
  const status = stored.status === "pending"
    ? await transitionDraft(env.DB, draftId, decision)
    : stored.status;
  if (!status || status === "pending") {
    return new Response("Ignored", { status: 200 });
  }

  const telegram = new TelegramClient(
    { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID },
    fetcher,
  );
  const changed = stored.status === "pending" && status === decision;
  let providerFailed = false;
  try {
    await telegram.answerCallback(
      callback.id,
      changed ? capitalize(status) : `Already ${status}`,
    );
  } catch (error) {
    providerFailed = true;
    console.error(errorCategory(error));
  }
  try {
    await telegram.editDraftState(
      stored.telegram_message_id,
      `${stored.body}\n\nSource: ${stored.canonical_url}`,
      status,
    );
  } catch (error) {
    providerFailed = true;
    console.error(errorCategory(error));
  }

  return providerFailed
    ? new Response("Provider error", { status: 502 })
    : new Response("OK", { status: 200 });
}

function parseCallbackQuery(value: unknown): CallbackQuery | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.data !== "string") {
    return null;
  }
  const message = isRecord(value.message) ? value.message : null;
  const chat = message && isRecord(message.chat) ? message.chat : null;
  if (!chat || (typeof chat.id !== "number" && typeof chat.id !== "string")) {
    return null;
  }
  return { id: value.id, data: value.data, chatId: String(chat.id) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "webhook_error";
  const category = error.message.split(":", 1)[0];
  return /^[a-z][a-z0-9_]{0,63}$/.test(category) ? category : "webhook_error";
}
