import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type { Database } from "./database.types.ts";
import {
  readRequiredEnv,
  type RuntimeEnvReader,
} from "./runtime-env.ts";

export function createAdminClient(
  readEnv: RuntimeEnvReader,
): SupabaseClient<Database> {
  const url = readRequiredEnv("SUPABASE_URL", readEnv);
  const keyMap = readEnv("SUPABASE_SECRET_KEYS");
  const key = keyMap
    ? parseDefaultSecretKey(keyMap)
    : readRequiredEnv("SUPABASE_SERVICE_ROLE_KEY", readEnv);

  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function parseDefaultSecretKey(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("default" in parsed) ||
      typeof parsed.default !== "string" ||
      parsed.default.trim().length === 0
    ) {
      throw new Error("invalid");
    }
    return parsed.default.trim();
  } catch {
    throw new Error("invalid_supabase_secret_keys");
  }
}
