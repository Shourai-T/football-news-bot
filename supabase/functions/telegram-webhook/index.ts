import { createTelegramWebhookViabilityHandler } from "./viability-handler.ts";

export default {
  fetch: createTelegramWebhookViabilityHandler({
    readEnv: (name) => Deno.env.get(name),
    fetcher: fetch,
  }),
};
