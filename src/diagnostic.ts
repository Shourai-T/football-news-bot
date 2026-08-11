import { TelegramClient } from "./telegram";
import type { Env } from "./types";

export async function handleTelegramHealth(
  request: Request,
  env: Env,
  fetcher: typeof fetch,
): Promise<Response> {
  if (request.headers.get("X-Diagnostic-Secret") !== env.DIAGNOSTIC_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const telegram = new TelegramClient(
      { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID },
      fetcher,
    );
    await telegram.checkHealth();
    return Response.json({ status: "ok" });
  } catch (error) {
    const category = errorCategory(error);
    console.error(JSON.stringify({ event: "telegram_health_failed", category }));
    return Response.json({ status: "unavailable", category }, { status: 502 });
  }
}

function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "diagnostic_error";
  const category = error.message.split(":", 1)[0];
  return /^[a-z][a-z0-9_]{0,63}$/.test(category) ? category : "diagnostic_error";
}
