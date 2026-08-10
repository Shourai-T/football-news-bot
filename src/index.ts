import { runScheduledPipeline } from "./pipeline";
import type { Env } from "./types";
import { handleTelegramWebhook } from "./webhook";

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runScheduledPipeline(env, controller.scheduledTime, fetch));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/telegram") {
      return new Response("Not found", { status: 404 });
    }
    return handleTelegramWebhook(request, env, fetch);
  },
} satisfies ExportedHandler<Env>;
