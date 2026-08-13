import { VERIFIED_FEEDS } from "../_shared/feed-config.ts";
import { generateDraft } from "../_shared/gemini.ts";
import {
  runScheduledPipeline,
  toSlotKey,
} from "../_shared/pipeline.ts";
import { selectBestCandidate } from "../_shared/ranking.ts";
import type { BotRepository } from "../_shared/repository.ts";
import {
  readRequiredEnv,
  type RuntimeEnvReader,
} from "../_shared/runtime-env.ts";
import { fetchFeedEntries } from "../_shared/rss.ts";
import { TelegramClient } from "../_shared/telegram.ts";

export interface ScheduledPipelineHandlerDependencies {
  readEnv: RuntimeEnvReader;
  fetcher: typeof fetch;
  createRepository: () => BotRepository;
  now: () => Date;
}

export function createScheduledPipelineHandler(
  dependencies: ScheduledPipelineHandlerDependencies,
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

    const scheduledAt = dependencies.now();
    let slotKey: string;
    try {
      slotKey = toSlotKey(scheduledAt);
    } catch {
      return Response.json({ status: "internal_failed" }, { status: 500 });
    }

    try {
      const botToken = readRequiredEnv("TELEGRAM_BOT_TOKEN", dependencies.readEnv);
      const chatId = readRequiredEnv("TELEGRAM_CHAT_ID", dependencies.readEnv);
      const apiKey = readRequiredEnv("GEMINI_API_KEY", dependencies.readEnv);
      const model = readRequiredEnv("GEMINI_MODEL", dependencies.readEnv);
      const outcome = await runScheduledPipeline({
        repository: dependencies.createRepository(),
        fetchFeeds: fetchFeedEntries,
        selectCandidate: selectBestCandidate,
        generate: generateDraft,
        telegram: new TelegramClient({ botToken, chatId }, dependencies.fetcher),
        feeds: VERIFIED_FEEDS,
        geminiConfig: { apiKey, model },
        fetcher: dependencies.fetcher,
      }, scheduledAt);
      return Response.json({ status: outcome, slotKey });
    } catch {
      return Response.json(
        { status: "internal_failed", slotKey },
        { status: 500 },
      );
    }
  };
}
