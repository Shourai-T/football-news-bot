import { describe, expect, it } from "vitest";
import { parseFeeds } from "../src/config";
// Vite loads the deployed Wrangler configuration as text for behavioral validation.
// @ts-expect-error The raw-import query is provided by Vite at test runtime.
import wranglerConfigText from "../wrangler.jsonc?raw";
// @ts-expect-error The raw-import query is provided by Vite at test runtime.
import devVarsExampleText from "../.dev.vars.example?raw";

describe("deployment feed configuration", () => {
  it("rejects non-HTTPS and incomplete feed definitions", () => {
    expect(() => parseFeeds('[{"name":"Club","url":"http://club.test/rss","priority":1}]'))
      .toThrow("HTTPS URL");
    expect(() => parseFeeds('[{"name":"Club","url":"https://club.test/rss"}]'))
      .toThrow("finite number");
  });

  it("keeps RSS source definitions as public structured configuration", () => {
    const raw = JSON.stringify([
      { name: "Official club", url: "https://club.test/rss", priority: 20 },
      { name: "League", url: "https://league.test/atom", priority: 10 },
    ]);

    expect(parseFeeds(raw)).toEqual([
      { name: "Official club", url: "https://club.test/rss", priority: 20 },
      { name: "League", url: "https://league.test/atom", priority: 10 },
    ]);
  });

  it("keeps relay bindings and excludes the bot token from the local Worker secret template", () => {
    const names = devVarsExampleText
      .split("\n")
      .filter((line: string) => !line.startsWith("#") && line.includes("="))
      .map((line: string) => line.split("=", 1)[0]);

    expect(names).toContain("TELEGRAM_RELAY_URL");
    expect(names).toContain("TELEGRAM_RELAY_SECRET");
    expect(names).not.toContain("TELEGRAM_BOT_TOKEN");
  });

  it("deploys the exact D1 binding, five Cron hours, and public feed set", () => {
    const config = JSON.parse(wranglerConfigText) as {
      triggers: { crons: string[] };
      d1_databases: Array<{ binding: string; database_id: string }>;
      vars: Record<string, string>;
    };
    const [minute, hours, dayOfMonth, month, dayOfWeek] = config.triggers.crons[0]!.split(" ");

    expect(config.triggers.crons).toHaveLength(1);
    expect({ minute, hours: hours?.split(","), dayOfMonth, month, dayOfWeek }).toEqual({
      minute: "7",
      hours: ["1", "4", "7", "10", "13"],
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    });
    expect(config.d1_databases).toContainEqual(expect.objectContaining({
      binding: "DB",
      database_id: "8ccd410d-2733-4987-b16f-b2b53375d558",
    }));
    expect(JSON.parse(config.vars.RSS_FEEDS_JSON!)).toEqual([
      {
        name: "BBC Sport Football",
        url: "https://feeds.bbci.co.uk/sport/football/rss.xml",
        priority: 100,
      },
      {
        name: "Sky Sports Football",
        url: "https://www.skysports.com/rss/12040",
        priority: 80,
      },
      {
        name: "Liverpool FC official",
        url: "https://www.liverpoolfc.com/?feed=rss2",
        priority: 70,
      },
    ]);
    expect(Object.keys(config.vars)).toEqual(["RSS_FEEDS_JSON"]);
    for (const secretName of [
      "TELEGRAM_RELAY_URL",
      "TELEGRAM_RELAY_SECRET",
      "TELEGRAM_CHAT_ID",
      "TELEGRAM_WEBHOOK_SECRET",
      "DIAGNOSTIC_SECRET",
      "GEMINI_API_KEY",
      "GEMINI_MODEL",
    ]) {
      expect(config.vars).not.toHaveProperty(secretName);
    }
  });
});
