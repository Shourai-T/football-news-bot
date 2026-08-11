import { createTelegramDiagnosticHandler } from "./handler.ts";

export default {
  fetch: createTelegramDiagnosticHandler({
    readEnv: (name) => Deno.env.get(name),
    fetcher: fetch,
  }),
};
