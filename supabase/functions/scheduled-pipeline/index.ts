import { createAdminClient } from "../_shared/database-client.ts";
import { SupabaseBotRepository } from "../_shared/repository.ts";
import { createScheduledPipelineHandler } from "./handler.ts";

const readEnv = (name: string): string | undefined => Deno.env.get(name);

export default {
  fetch: createScheduledPipelineHandler({
    readEnv,
    fetcher: fetch,
    createRepository: () => new SupabaseBotRepository(createAdminClient(readEnv)),
    now: () => new Date(),
  }),
};
