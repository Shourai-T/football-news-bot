# Football News Bot

Supabase Edge Functions collect verified football RSS/Atom feeds, select one eligible story, ask Gemini for a factual English draft, and send it to a private Telegram chat for approval or rejection. Supabase Cron runs five content slots per Vietnam day, and Postgres enforces deduplication and the daily Gemini quota.

Approval is stored durably in Postgres. An approved draft is **not published to X yet**. X API authentication, posting, retries, and reconciliation belong to a separate implementation phase.

## Architecture

```text
Supabase Cron (5 slots/day)
  -> scheduled-pipeline Edge Function
  -> BBC / Sky Sports / Liverpool FC RSS
  -> Postgres deduplication and Gemini quota reservation
  -> Gemini draft generation
  -> Telegram Approve / Reject message

Telegram callback
  -> telegram-webhook Edge Function
  -> Postgres approved / rejected state
```

Supabase is the only active runtime in this repository.

## Requirements

- Node.js
- Docker Desktop
- Supabase CLI
- A Supabase project
- A Telegram bot and private chat ID
- A Gemini API key

Install dependencies:

```sh
npm install
```

## Local configuration

Copy the example without committing the result:

```sh
cp supabase/functions/.env.example supabase/functions/.env.local
```

Set these local values in `supabase/functions/.env.local`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `SCHEDULED_FUNCTION_SECRET`

Never place secret values in source files, command arguments, logs, issues, or chat.

## Local verification

Start the local stack, reset the database, and run every verification layer:

```sh
npm run supabase:start
npx supabase db reset
npm run typecheck
npm test
npm run test:db
npm run test:integration
npx supabase db lint --level warning
```

Unit tests mock external providers. Database tests and repository integration tests use the local Supabase stack; they do not contact Telegram or Gemini.

To verify that each function bundles and reaches Ready locally, run these commands in separate terminals:

```sh
npx supabase functions serve telegram-webhook --env-file supabase/functions/.env.local
npx supabase functions serve scheduled-pipeline --env-file supabase/functions/.env.local
```

Stop the local stack when finished:

```sh
npm run supabase:stop
```

## Hosted Supabase configuration

Create these Edge Function secrets in the Supabase Dashboard:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `SCHEDULED_FUNCTION_SECRET`

Create these Database Vault secrets:

- `project_url`: the project origin, such as `https://PROJECT_REF.supabase.co`
- `scheduled_function_secret`: the same value as `SCHEDULED_FUNCTION_SECRET`

Inspect only Vault secret names when diagnosing configuration. Do not select or print decrypted values.

## Deployment

Link the CLI to the intended project, then deploy the migration and both production functions:

```sh
npx supabase link --project-ref PROJECT_REF
npx supabase db push
npx supabase functions deploy telegram-webhook --use-api
npx supabase functions deploy scheduled-pipeline --use-api
```

## Telegram webhook

The helper receives credentials over standard input so they do not appear in the child process argument list:

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

The helper fails closed if Telegram reports pending updates or a recent delivery error. Approve one controlled draft and confirm its Postgres status becomes `approved` before relying on scheduled execution.

## Manual pipeline invocation

Use exactly one authenticated smoke invocation when validating a new deployment. Do not repeat it merely because the client timed out; first inspect `scheduled_runs` for a completed remote invocation.

```sh
printf 'Scheduled function secret: '
IFS= read -rs SCHEDULED_TEST_SECRET
printf '\nSupabase project ref: '
IFS= read -r SUPABASE_PROJECT_REF
printf '%s\0%s\0' "$SCHEDULED_TEST_SECRET" "$SUPABASE_PROJECT_REF" \
  | node scripts/smoke-scheduled-pipeline.mjs
unset SCHEDULED_TEST_SECRET SUPABASE_PROJECT_REF
```

Accepted terminal statuses are `no_candidate` and `draft_sent`. The helper waits up to 160 seconds, which is longer than the Supabase Free 150-second function ceiling. Individual provider requests inside the function remain capped at 8 seconds.

## Cron operations

Run `supabase/ops/configure-cron.sql` in the Supabase SQL Editor to install exactly one active job named `football-news-pipeline`. Then run `supabase/ops/verify-cron.sql`; it raises an exception if the job count, schedule, active flag, HTTP command, or Vault lookups drift.

The schedule is:

```text
UTC:              01:07  04:07  07:07  10:07  13:07
Asia/Ho_Chi_Minh: 08:07  11:07  14:07  17:07  20:07
```

Disable the job with `supabase/ops/disable-cron.sql` before rollback or maintenance that must stop new drafts.

## Monitoring and logs

For each production slot:

1. Inspect Supabase Dashboard → Edge Functions → `scheduled-pipeline` → Logs and require an HTTP 2xx invocation.
2. Inspect `cron.job_run_details` for the scheduler execution.
3. Inspect `public.scheduled_runs` for a terminal pipeline outcome.
4. For `draft_sent`, confirm a matching `public.drafts.telegram_message_id` and Telegram message.

A `succeeded` Cron row proves only that the asynchronous HTTP request was accepted; it does not by itself prove the Edge Function returned 2xx or completed the content pipeline.

Logs must contain bounded categories and identifiers only. Never log Telegram payloads, article excerpts, Gemini prompts, or secrets.

## Rollback

1. Run `supabase/ops/disable-cron.sql` and verify the named job is absent.
2. Keep the Telegram webhook on the current known-good function unless the webhook itself is the failure.
3. Redeploy the last known-good Supabase commit for the affected function and migration-compatible code.
4. Re-run one controlled smoke test and callback before restoring Cron with `supabase/ops/configure-cron.sql`.

Never enable two schedulers for the same five slots.

## Retired infrastructure cleanup

After the observed scheduled draft and approval are durable in Postgres:

- Delete the Google Apps Script web-app deployment and remove its Script Properties.
- Delete the relay-only and diagnostic secrets from the disabled Cloudflare Worker.
- Keep the Cloudflare Worker disabled.
- Keep the remote D1 database as a read-only backup until the operator separately authorizes deletion.

The repository no longer contains the retired Worker or relay runtime. Earlier design and migration documents remain as historical records only.

## Free-plan operating limits

Supabase Free has no uptime SLA and an inactive project may be paused. Check project health, Cron history, Edge Function logs, and `scheduled_runs` after any pause or restart. The bot deliberately uses only five scheduled slots and at most five Gemini reservations per Vietnam day to keep provider and platform usage bounded.

Only configured public RSS/Atom endpoints are fetched; article pages are not scraped.
