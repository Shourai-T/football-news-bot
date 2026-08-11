import { TelegramClient, TelegramRequestError } from "./telegram";
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
    const transport = error instanceof TelegramRequestError ? error.transport : "fetch_rejected";
    console.error(JSON.stringify({ event: "telegram_health_failed", category }));
    return Response.json({ status: "unavailable", category, transport }, { status: 502 });
  }
}

function errorCategory(error: unknown): string {
  return error instanceof TelegramRequestError ? error.message : "diagnostic_error";
}
