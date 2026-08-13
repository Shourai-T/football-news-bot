# Football News Bot

Supabase Edge Functions fetch verified football RSS/Atom feeds, select one eligible story, ask Gemini for a factual English draft, and send it to a private Telegram chat for approval or rejection. The bot runs at most five content slots per Vietnam day.

Approval is stored durably in Postgres. Publishing to X is intentionally not implemented yet; X API credits and OAuth are a separate phase.

## Runtime architecture

```text
Supabase Cron (5 slots/day)
  -> scheduled-pipeline Edge Function
  -> BBC / Sky Sports / Liverpool FC RSS
  -> Postgres deduplication and Gemini quota reservation
  -> Gemini draft
  -> Telegram Approve / Reject message

Telegram callback
  -> telegram-webhook Edge Function
  -> Postgres approved / rejected state
```

Cloudflare Worker, D1, and Google Apps Script are rollback-only until the Supabase production smoke test and one approval succeed. Do not run Cloudflare Cron and Supabase Cron at the same time.

## Local verification

Requirements: Node.js, Docker Desktop, Deno, and Supabase CLI.

```sh
npm install
npx supabase start
npx supabase db reset
npm test
npm run typecheck
npm run typecheck:supabase
npm run test:integration
npx supabase test db
npx supabase db lint --level warning
```

Tests use mock provider calls and local Postgres. They do not contact Telegram or Gemini.

## Supabase configuration

The hosted project needs these Edge Function secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `SCHEDULED_FUNCTION_SECRET`

Enter secret values only through Supabase Dashboard or an interactive CLI prompt. Never put them in source files, command arguments, logs, or chat.

Deploy the database and functions:

```sh
npx supabase db push
npx supabase functions deploy telegram-webhook --use-api
npx supabase functions deploy scheduled-pipeline --use-api
```

## Production cutover

Execute these checkpoints in order.

1. Run the complete local verification gate above.
2. Apply `npx supabase db push` and deploy both functions.
3. Inspect the old D1 database read-only with the account that owns database `8ccd410d-2733-4987-b16f-b2b53375d558`:

```sh
npx wrangler d1 execute DB --remote --command \
  "SELECT (SELECT COUNT(*) FROM articles) AS articles, (SELECT COUNT(*) FROM drafts) AS drafts, (SELECT COUNT(*) FROM drafts WHERE status = 'pending') AS pending_drafts, (SELECT COUNT(*) FROM drafts WHERE status = 'approved') AS approved_drafts, (SELECT COUNT(*) FROM scheduled_runs) AS scheduled_runs, (SELECT COUNT(*) FROM daily_usage) AS daily_usage"
```

Any command failure, missing table, incomplete count, or non-zero `pending_drafts`/`approved_drafts` count is a hard stop. Do not run the smoke test, switch webhooks, or enable Cron until the inspection succeeds and any live drafts are exported and reconciled. Failed runs and diagnostics do not need migration.

`D1_CUTOVER_CLEARED` on 2026-08-13: the read-only query succeeded with `articles = 24`, `drafts = 11`, `pending_drafts = 0`, `approved_drafts = 0`, `scheduled_runs = 24`, and `daily_usage = 3`. No live draft requires migration.
4. In Supabase Dashboard → Vault, create:
   - `project_url`: the project origin, for example `https://PROJECT_REF.supabase.co`.
   - `scheduled_function_secret`: the same value stored as the Edge Function secret `SCHEDULED_FUNCTION_SECRET`.
5. Run exactly one authenticated scheduled-pipeline smoke test before enabling Cron:

```sh
printf 'Scheduled function secret: '
IFS= read -rs SCHEDULED_TEST_SECRET
printf '\nSupabase project ref: '
IFS= read -r SUPABASE_PROJECT_REF
printf '%s\0%s\0' "$SCHEDULED_TEST_SECRET" "$SUPABASE_PROJECT_REF" \
  | node scripts/smoke-scheduled-pipeline.mjs
unset SCHEDULED_TEST_SECRET SUPABASE_PROJECT_REF
```

The expected status is `no_candidate` or `draft_sent`. `draft_sent` must correspond to one Postgres run, article, draft, and quota reservation.

6. Register Telegram directly to Supabase. The shell built-in sends credentials to the helper over stdin; secrets never appear in a child process argument list:

```sh
printf 'Telegram bot token: '
IFS= read -rs TELEGRAM_SETUP_TOKEN
printf '\nTelegram webhook secret: '
IFS= read -rs TELEGRAM_SETUP_SECRET
printf '\nSupabase project ref: '
IFS= read -r SUPABASE_PROJECT_REF
printf '%s\0%s\0%s\0' \
  "$TELEGRAM_SETUP_TOKEN" "$TELEGRAM_SETUP_SECRET" "$SUPABASE_PROJECT_REF" \
  | node scripts/configure-telegram-webhook.mjs
unset TELEGRAM_SETUP_TOKEN TELEGRAM_SETUP_SECRET SUPABASE_PROJECT_REF
```

Verify the Supabase URL, zero pending updates, and no recent delivery error. Approve one controlled draft and confirm its Postgres status becomes `approved`.

7. Disable the Cloudflare Cron trigger in Cloudflare Dashboard. Do not delete D1.
8. Run `supabase/ops/configure-cron.sql` in Supabase SQL Editor.
9. Run `supabase/ops/verify-cron.sql`. It raises an exception unless exactly one active job named `football-news-pipeline` uses `7 1,4,7,10,13 * * *` and performs the required Vault lookups.
10. After the first scheduled invocation, open Supabase Dashboard → Edge Functions → scheduled-pipeline → Logs. Require an HTTP 2xx invocation and a matching terminal row in `scheduled_runs`. A `succeeded` row in `cron.job_run_details` only proves that `pg_net` accepted the HTTP request; it does not prove the Edge Function returned 2xx.

The schedule is `01:07`, `04:07`, `07:07`, `10:07`, and `13:07` UTC, corresponding to `08:07`, `11:07`, `14:07`, `17:07`, and `20:07` in `Asia/Ho_Chi_Minh`.

## Rollback

Run `supabase/ops/disable-cron.sql` first. Restore the previous Telegram webhook only if its transport is known to work, then re-enable Cloudflare Cron. Never leave both schedulers enabled. Do not delete D1 during rollback.

## Operations and safety

- Use only configured public RSS/Atom endpoints; do not scrape article pages.
- Postgres enforces unique slots, unique canonical URLs, terminal draft decisions, and at most five Gemini reservations per Vietnam date.
- Logs contain bounded categories and identifiers, never secrets, Telegram request bodies, article excerpts, or Gemini prompts.
- Supabase Free has no uptime SLA and may impose platform limits; the five daily jobs are designed to remain lightweight.
