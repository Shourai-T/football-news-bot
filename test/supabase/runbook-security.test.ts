import { describe, expect, it } from "vitest";
import readme from "../../README.md?raw";
import telegramHelper from "../../scripts/configure-telegram-webhook.mjs?raw";
import smokeHelper from "../../scripts/smoke-scheduled-pipeline.mjs?raw";

describe("Supabase cutover runbook", () => {
  it("passes operator secrets through stdin instead of curl arguments", () => {
    expect(readme).toContain("scripts/smoke-scheduled-pipeline.mjs");
    expect(readme).toContain("scripts/configure-telegram-webhook.mjs");
    expect(readme).not.toContain('"X-Scheduled-Secret: $SCHEDULED_TEST_SECRET"');
    expect(readme).not.toContain("bot$TELEGRAM_SETUP_TOKEN");
    expect(readme).not.toContain('--data "{\\"url\\"');
  });

  it("makes incomplete D1 inspection a hard stop and records the cleared checkpoint", () => {
    expect(readme).toContain("D1_CUTOVER_CLEARED");
    expect(readme).toContain("pending_drafts = 0");
    expect(readme).toContain("approved_drafts = 0");
    expect(readme).toContain("(SELECT COUNT(*) FROM drafts)");
    expect(readme).not.toContain("UNION ALL");
    expect(readme).toContain("Do not run the smoke test, switch webhooks, or enable Cron");
    expect(readme).toContain("pending_drafts");
    expect(readme).toContain("approved_drafts");
  });

  it("requires function-log verification after a Cron invocation", () => {
    expect(readme).toContain("Edge Functions → scheduled-pipeline → Logs");
    expect(readme).toContain("HTTP 2xx");
  });

  it("fails smoke checks closed and allows the whole pipeline to finish", () => {
    expect(smokeHelper).toContain('["no_candidate", "draft_sent"]');
    expect(smokeHelper).toContain("unexpected_status");
    expect(smokeHelper).toContain("AbortSignal.timeout(160_000)");
    expect(smokeHelper).not.toContain("AbortSignal.timeout(8_000)");
  });

  it("rejects pending updates and recent Telegram delivery errors", () => {
    expect(telegramHelper).toContain("pending_update_count !== 0");
    expect(telegramHelper).toContain('"last_error_date" in result');
    expect(telegramHelper).toContain("webhook_delivery_unhealthy");
    expect(telegramHelper).toContain("AbortSignal.timeout(8_000)");
    expect(telegramHelper).not.toContain("30_000");
  });
});
