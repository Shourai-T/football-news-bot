import { describe, expect, it } from "vitest";
import readme from "../../README.md?raw";
import packageLock from "../../package-lock.json?raw";
import packageJson from "../../package.json?raw";
import tsconfig from "../../tsconfig.json?raw";
import vitestConfig from "../../vitest.config.ts?raw";
import integrationVitestConfig from "../../vitest.supabase.config.ts?raw";

const activeRuntimeModules = import.meta.glob(
  [
    "../../src/**/*",
    "../../relay/**/*",
    "../../migrations/**/*",
    "../../scripts/**/*",
    "../../supabase/functions/**/*.ts",
    "../../wrangler.jsonc",
    "../../.dev.vars.example",
  ],
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

describe("active runtime boundary", () => {
  it("keeps the repository runtime Supabase-only", () => {
    const activeRuntimeText = [
      readme,
      packageLock,
      packageJson,
      tsconfig,
      vitestConfig,
      integrationVitestConfig,
      ...Object.keys(activeRuntimeModules),
      ...Object.values(activeRuntimeModules),
    ].join("\n");

    for (const forbidden of [
      "wrangler",
      "D1Database",
      "TELEGRAM_RELAY_URL",
      "TELEGRAM_RELAY_SECRET",
      "script.google",
      "relay/Code.gs",
    ]) {
      expect(activeRuntimeText).not.toContain(forbidden);
    }
  });
});
