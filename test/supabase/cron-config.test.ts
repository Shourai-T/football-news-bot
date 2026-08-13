import { describe, expect, it } from "vitest";
import configureSql from "../../supabase/ops/configure-cron.sql?raw";
import disableSql from "../../supabase/ops/disable-cron.sql?raw";
import verifySql from "../../supabase/ops/verify-cron.sql?raw";

describe("Supabase Cron operations", () => {
  it("configures exactly one named five-slot job from Vault values", () => {
    expect(configureSql).toContain("'football-news-pipeline'");
    expect(configureSql).toContain("'7 1,4,7,10,13 * * *'");
    expect(configureSql).toContain("name = 'project_url'");
    expect(configureSql).toContain("name = 'scheduled_function_secret'");
    expect(configureSql).toContain("'/functions/v1/scheduled-pipeline'");
    expect(configureSql).toContain("'X-Scheduled-Secret'");
    expect(configureSql).toContain("for existing_job in");
    expect(configureSql).toContain("perform cron.unschedule(existing_job.jobid)");
    expect(configureSql).not.toMatch(/sb_secret_|bot\d+:/u);
  });

  it("disables only the named football pipeline job", () => {
    expect(disableSql).toContain("'football-news-pipeline'");
    expect(disableSql).toContain("cron.unschedule");
    expect(disableSql).toContain("for existing_job in");
    expect(disableSql).not.toContain("delete from cron.job");
  });

  it("asserts exact active job invariants without selecting Vault values", () => {
    expect(verifySql).toContain("cron.job");
    expect(verifySql).toContain("cron.job_run_details");
    expect(verifySql).toContain("matching_count <> 1");
    expect(verifySql).toContain("schedule <> '7 1,4,7,10,13 * * *'");
    expect(verifySql).toContain("raise exception");
    expect(verifySql).toContain("name = 'project_url'");
    expect(verifySql).toContain("name = 'scheduled_function_secret'");
    expect(verifySql).toContain("net.http_post");
    expect(verifySql).toContain("'X-Scheduled-Secret'");
    expect(verifySql).toContain("regexp_replace");
    expect(verifySql).toContain("expected_command");
    expect(verifySql).not.toContain("select * from vault.decrypted_secrets");
    expect(verifySql).not.toMatch(/sb_secret_|bot\d+:/u);
  });
});
