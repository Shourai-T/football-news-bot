import { describe, expect, it } from "vitest";
import { createAdminClient } from "../../supabase/functions/_shared/database-client";

describe("Supabase admin client configuration", () => {
  it("uses the hosted default secret-key map without requiring a legacy key", () => {
    const env = new Map([
      ["SUPABASE_URL", "https://project.supabase.co"],
      ["SUPABASE_SECRET_KEYS", JSON.stringify({
        default: "hosted-test-key",
      })],
    ]);

    expect(() => createAdminClient((name) => env.get(name))).not.toThrow();
  });

  it("rejects malformed hosted secret-key maps without exposing their value", () => {
    const malformed = "not-json-sensitive-value";
    const env = new Map([
      ["SUPABASE_URL", "https://project.supabase.co"],
      ["SUPABASE_SECRET_KEYS", malformed],
    ]);

    expect(() => createAdminClient((name) => env.get(name))).toThrow(
      "invalid_supabase_secret_keys",
    );
    expect(() => createAdminClient((name) => env.get(name))).not.toThrow(
      malformed,
    );
  });

  it("rejects a hosted secret-key map without a non-empty default", () => {
    const env = new Map([
      ["SUPABASE_URL", "https://project.supabase.co"],
      ["SUPABASE_SECRET_KEYS", JSON.stringify({ default: "   " })],
    ]);

    expect(() => createAdminClient((name) => env.get(name))).toThrow(
      "invalid_supabase_secret_keys",
    );
  });
});
