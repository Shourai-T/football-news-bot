import {
  readRequiredEnv,
  type RuntimeEnvReader,
} from "../_shared/runtime-env.ts";
import { TelegramClient } from "../_shared/telegram.ts";

export interface DiagnosticDependencies {
  readEnv: RuntimeEnvReader;
  fetcher: typeof fetch;
}

type DiagnosticOperation = "getMe" | "sendMessage";

export function createTelegramDiagnosticHandler(
  dependencies: DiagnosticDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json({ status: "method_not_allowed" }, { status: 405 });
    }

    let expectedSecret: string;
    try {
      expectedSecret = readRequiredEnv(
        "SCHEDULED_FUNCTION_SECRET",
        dependencies.readEnv,
      );
    } catch {
      return Response.json({ status: "misconfigured" }, { status: 500 });
    }
    if (request.headers.get("X-Scheduled-Secret") !== expectedSecret) {
      return Response.json({ status: "unauthorized" }, { status: 401 });
    }

    let operation: DiagnosticOperation;
    try {
      const payload: unknown = await request.json();
      if (!isDiagnosticPayload(payload)) {
        return Response.json({ status: "bad_request" }, { status: 400 });
      }
      operation = payload.operation;
    } catch {
      return Response.json({ status: "bad_request" }, { status: 400 });
    }

    let telegram: TelegramClient;
    try {
      telegram = new TelegramClient(
        {
          botToken: readRequiredEnv(
            "TELEGRAM_BOT_TOKEN",
            dependencies.readEnv,
          ),
          chatId: readRequiredEnv(
            "TELEGRAM_CHAT_ID",
            dependencies.readEnv,
          ),
        },
        dependencies.fetcher,
      );
    } catch {
      return Response.json({ status: "misconfigured" }, { status: 500 });
    }

    try {
      if (operation === "getMe") {
        await telegram.checkHealth();
      } else {
        await telegram.sendDiagnostic();
      }
      return Response.json({ status: "ok", operation });
    } catch (error) {
      return Response.json(
        { status: "unavailable", category: errorCategory(error) },
        { status: 502 },
      );
    }
  };
}

function isDiagnosticPayload(
  value: unknown,
): value is { operation: DiagnosticOperation } {
  return typeof value === "object" &&
    value !== null &&
    "operation" in value &&
    (value.operation === "getMe" || value.operation === "sendMessage") &&
    Object.keys(value).length === 1;
}

function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "telegram_error";
  const category = error.message.split(":", 1)[0];
  return /^[a-z][a-z0-9_]{0,63}$/.test(category)
    ? category
    : "telegram_error";
}
