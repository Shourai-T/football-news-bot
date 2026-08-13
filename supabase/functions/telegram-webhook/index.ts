import { createAdminClient } from "../_shared/database-client.ts";
import { SupabaseBotRepository } from "../_shared/repository.ts";
import { createTelegramWebhookHandler } from "./handler.ts";

const readEnv = (name: string): string | undefined => Deno.env.get(name);

export default {
  fetch: createTelegramWebhookHandler({
    readEnv,
    fetcher: fetch,
    repository: new SupabaseBotRepository(createAdminClient(readEnv)),
  }),
};
