# Football News Bot — Supabase Platform Migration Design

> **Supersedes:** The Cloudflare Worker, D1, and Google Apps Script Telegram
> relay architecture documented in earlier design files. Those files remain as
> historical records only.

## Objective

Move the football-news bot to a single cloud platform that can call Telegram
directly, receive Telegram callbacks through a standard webhook, run five
scheduled content jobs per day, persist durable state, and stay comfortably
inside a free-tier allowance. The migration must prove network compatibility
before any production traffic is moved or any existing resource is removed.

The end-to-end product goal remains publishing approved posts to X. This
migration stops at a durable Telegram-approved draft because X publishing has
independent paid API, credit, and OAuth requirements. X integration will be a
separate design and implementation cycle after the Supabase pipeline is live.

## Decision

Use these managed Supabase services:

- Edge Functions, written in TypeScript for the Deno runtime.
- Postgres for articles, drafts, run history, and daily quota reservations.
- Supabase Cron (`pg_cron`) and `pg_net` for scheduled function invocation.
- Supabase project secrets for external API credentials.
- Supabase Vault for the URL and authentication value used by Cron to invoke
  the private scheduled function.

Do not retain Google Apps Script as a relay. Do not use Cloudflare Worker or D1
in the final runtime. The existing Cloudflare deployment remains available
only as a rollback reference until Supabase passes the production smoke test.

## Scope

Included:

- A fail-fast Supabase-to-Telegram viability check.
- Direct Telegram Bot API requests from Supabase Edge Functions.
- Direct Telegram webhook delivery to Supabase.
- Migration of the existing RSS selection, deduplication, Gemini quota, draft
  generation, and approval behavior.
- Postgres migrations for the existing durable records.
- Exactly five scheduled runs per Vietnam calendar day.
- Deployment, smoke-test, cutover, rollback, and old-relay cleanup guidance.

Excluded:

- X API credentials, OAuth, credit purchase, or publishing calls.
- Article-page scraping, browser automation, or copyrighted full-text storage.
- Media generation, a web dashboard, multi-user support, and automatic
  retention deletion.
- Deleting the Cloudflare D1 database. Deletion requires a later explicit
  retention decision.

## Architecture

```text
Supabase Cron (five UTC slots)
  -> authenticated POST /functions/v1/scheduled-pipeline
  -> parallel RSS/Atom fetch with timeouts
  -> deterministic normalize, deduplicate, filter, and rank
  -> Postgres run-slot and Gemini daily-quota reservation
  -> Gemini draft generation
  -> direct Telegram sendMessage with Approve / Reject buttons

Telegram callback_query
  -> POST /functions/v1/telegram-webhook
  -> Telegram webhook-secret and configured-chat validation
  -> idempotent Postgres draft transition
  -> direct answerCallbackQuery and editMessageText calls
```

Two independently deployable functions keep the public webhook boundary
separate from the privileged scheduled pipeline:

- `scheduled-pipeline` accepts only the Cron authentication value. It performs
  one complete content run and is safe to retry for the same slot.
- `telegram-webhook` is publicly reachable because Telegram cannot send
  Supabase credentials. It authenticates every request using Telegram's
  `X-Telegram-Bot-Api-Secret-Token` header and then validates the callback chat,
  message, action, and draft identifier.

Shared domain modules contain RSS parsing, ranking, Gemini, Telegram, quota,
and repository behavior. Function entrypoints contain only request
authentication, input validation, orchestration, and response mapping.

## Viability Gate

Network compatibility is proven before porting the application:

1. Deploy a temporary authenticated diagnostic function with no database
   mutation and no Gemini call.
2. From that function, call Telegram `getMe` using a Supabase secret.
3. From that function, send one clearly labelled diagnostic message to the
   configured private chat.
4. Deploy the minimal `telegram-webhook`, register it with Telegram using a
   webhook secret, and verify that a controlled callback reaches the function.
5. Inspect function logs to confirm outbound and inbound requests completed
   without leaking tokens, chat content, or request bodies.

The migration may continue only when every viability check succeeds. If
Supabase cannot call Telegram directly, stop the migration and leave the
Cloudflare deployment untouched. Do not add another relay.

## Scheduling and Quota Control

Preserve the current schedule at `08:07`, `11:07`, `14:07`, `17:07`, and
`20:07` in `Asia/Ho_Chi_Minh`. Supabase Cron uses the UTC expression
`7 1,4,7,10,13 * * *`.

Each invocation derives a unique UTC slot key and the corresponding Vietnam
calendar date. Postgres must enforce these invariants transactionally:

- A slot key can start at most once.
- A canonical article URL can be selected at most once.
- At most five Gemini requests can be reserved for one Vietnam calendar date.
- One scheduled run can reserve Gemini quota at most once.
- A repeated callback cannot move a terminal draft to another state.

No eligible article means no Gemini request. Feed failures are isolated; the
run continues when at least one configured feed succeeds. Gemini and Telegram
requests have bounded timeouts. Automatic retries are allowed only for
idempotent operations or operations guarded by a durable idempotency key.

## Persistent Data

Postgres keeps the existing logical entities:

- `articles`: canonical URL, title, source, publication time, selected time,
  and selection metadata.
- `drafts`: article reference, generated text, Telegram message ID, status,
  and decision timestamps.
- `scheduled_runs`: unique slot key, Vietnam date, outcome, bounded error
  category, Gemini reservation marker, and timestamps.
- `daily_usage`: unique Vietnam date and Gemini reservation count.

Database constraints, not application-only checks, enforce unique URLs, unique
slot keys, valid statuses, and non-negative counters. The quota reservation is
implemented in a Postgres transaction or database function so concurrent
invocations cannot exceed five requests. Secrets, raw Telegram updates, Gemini
keys, and full article bodies are never stored.

The migration does not assume D1 is empty. Before cutover, inspect D1 row
counts. If any approved or pending draft exists, export and reconcile those
rows; otherwise initialize Postgres from the schema only. Historical failed
runs and diagnostics are not migrated.

## Configuration and Secrets

Versioned, non-secret configuration contains:

- Verified public RSS/Atom feed URLs and source priorities.
- Topic taxonomy and ranking weights.
- The five-slot Cron expression.
- Gemini output constraints and application timeouts.

Supabase project secrets contain:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `SCHEDULED_FUNCTION_SECRET`

Cron's project URL and invocation credential are stored in Supabase Vault. No
credential value is passed in a command argument, committed file, test fixture,
log field, or chat message. Operators enter secrets through an interactive CLI
prompt or the Supabase dashboard.

## Telegram Approval Behavior

Draft messages contain the English draft, source name, canonical source URL,
and inline `Approve` and `Reject` buttons. Callback data keeps the existing
compact action-plus-draft-ID format.

For every callback, the webhook function:

1. Verifies the Telegram webhook-secret header using an exact comparison.
2. Accepts only the configured private chat.
3. Confirms the callback message ID matches the stored draft message.
4. Atomically changes a `pending` draft to `approved` or `rejected`.
5. Answers the callback and edits the Telegram message to display the durable
   final state.

Duplicate or late callbacks return a successful acknowledgement without a
second state transition. Approval does not publish to X in this migration.

## Error Handling and Observability

Externally visible responses use stable status codes and generic error
categories. Logs contain structured operational metadata such as function,
slot key, draft ID, source count, duration, and error category. Logs never
contain tokens, secret headers, Telegram request bodies, article excerpts, or
Gemini prompts.

The scheduled function records one terminal outcome per slot:

- `no_candidate`
- `draft_sent`
- `rss_unavailable`
- `quota_limited`
- `gemini_failed`
- `telegram_failed`
- `internal_failed`

A Telegram delivery failure keeps the generated draft and marks it failed so
an operator can inspect it without spending another Gemini request. Webhook
authentication failures never query or mutate draft state.

Supabase Free retains limited logs and can pause projects with low activity.
The five daily jobs are expected to generate regular database activity, but
the operator must still respond to any Supabase inactivity warning. Production
use requiring an uptime SLA is outside the Free-plan guarantee.

## Testing

Automated tests run without external credentials or network access:

- Unit tests cover RSS/Atom parsing, canonicalization, ranking, Gemini prompt
  and response parsing, Telegram request construction, and error mapping.
- Repository tests run against local Supabase Postgres and prove slot, URL,
  quota, and callback concurrency invariants.
- Function tests verify scheduled authentication, Telegram webhook-secret and
  chat validation, method restrictions, malformed payloads, and idempotent
  responses.
- Pipeline tests mock RSS, Gemini, and Telegram and prove that no candidate
  consumes no Gemini request, the sixth daily reservation is rejected, and a
  Telegram failure does not consume a second Gemini request on retry.

Manual production smoke tests are limited to the viability gate, one forced
scheduled run using a controlled candidate, one Telegram approval, and database
verification. They occur before enabling Cron.

## Cutover and Rollback

Cutover order:

1. Pass the Supabase viability gate.
2. Apply Postgres migrations and deploy both production functions.
3. Run all automated tests and the controlled scheduled-run smoke test.
4. Point Telegram's webhook to Supabase and verify `getWebhookInfo` reports no
   delivery error.
5. Enable Supabase Cron.
6. Disable Cloudflare Cron so two schedulers cannot generate duplicate drafts.
7. Observe one complete scheduled slot and one approval.
8. Remove Apps Script relay code and relay-only secrets from the active setup.
9. Remove the Cloudflare diagnostic endpoint and mark the Cloudflare Worker as
   retired; retain D1 until a separate deletion decision.

If a production smoke test fails after webhook cutover, disable Supabase Cron,
restore the previous Telegram webhook URL, and re-enable Cloudflare Cron only
if its Telegram transport is known to be functional. The D1 database is never
deleted by rollback automation.

## Acceptance Criteria

- Supabase calls Telegram `getMe` and `sendMessage` directly without a relay.
- Telegram delivers verified callback queries directly to Supabase.
- The bot runs without a personal computer being online.
- Exactly five daily slots are configured at the preserved Vietnam times.
- No more than five Gemini requests are reserved per Vietnam calendar day,
  including concurrent or retried invocations.
- No candidate consumes no Gemini request, and a canonical article is never
  drafted twice.
- Approval and rejection are durable, chat-restricted, and idempotent.
- All tests and the controlled production smoke test pass before Cron cutover.
- Cloudflare Cron is disabled before Supabase Cron becomes authoritative.
- Google Apps Script and relay-only secrets are removed after successful
  observation, while D1 is retained pending an explicit deletion decision.
- No secret is committed, logged, or included in shell history.
- No X API call or credential is introduced in this migration.

## Official References

- [Supabase Edge Function pricing](https://supabase.com/docs/guides/functions/pricing)
- [Scheduling Supabase Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Securing Supabase Edge Functions](https://supabase.com/docs/guides/functions/auth)
- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook)
- [X API pay-per-use pricing](https://docs.x.com/x-api/getting-started/pricing)
