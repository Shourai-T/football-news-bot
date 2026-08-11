# Football News Bot — Cloud MVP Design

> **Superseded Telegram secret guidance:** `TELEGRAM_BOT_TOKEN` is no longer a Cloudflare/Worker secret. Keep it only in Google Apps Script Script Properties and follow the current [Google Apps Script Telegram relay README](../../../README.md#google-apps-script-telegram-relay). Any conflicting token-placement guidance below is historical.

## Objective

Run a zero-server football-news workflow in the cloud. At five fixed daily
times, it selects one fresh football article, uses Gemini to write an English
draft, and sends that draft to a private Telegram chat for approval or
rejection. This MVP does not publish to X.

## Scope

- Runtime: Cloudflare Worker written in TypeScript.
- State: Cloudflare D1.
- Scheduling: Cloudflare Cron Triggers.
- Interaction: Telegram Bot API webhooks and inline `Approve` / `Reject`
  buttons.
- Content sources: configured RSS feeds from BBC Sport, ESPN, Sky Sports,
  UEFA, FIFA, Premier League, and official club sites.
- AI: Gemini, configured through a Worker secret rather than source code.
- Maximum AI use: five Gemini generation requests per local calendar day.

Out of scope: X API integration, automatic X posting, a dashboard, media
generation, full-text scraping, and multi-user support.

## Architecture

```text
Cloudflare Cron (five slots in Asia/Ho_Chi_Minh)
  -> Worker scheduled handler
  -> RSS fetch and local ranking
  -> D1 deduplication / daily quota guard
  -> Gemini draft generation
  -> Telegram sendMessage with inline buttons

Telegram callback webhook
  -> Worker fetch handler
  -> signature and chat validation
  -> D1 draft state transition
  -> Telegram answerCallbackQuery and message update
```

Cron expressions are stored in UTC because Cloudflare Cron Triggers use UTC.
The initial schedule is 08:07, 11:07, 14:07, 17:07, and 20:07 in Vietnam
(UTC+7): `7 1,4,7,10,13 * * *`. The seven-minute offset avoids the busiest
top-of-hour scheduler window.

The Worker is one deployable application with two entry paths:

- `scheduled()` runs the content pipeline.
- `fetch()` receives Telegram webhook callbacks. It does not expose public
  management endpoints.

This keeps the approval endpoint permanently reachable without a running Mac.

## Content selection and quota control

Each scheduled invocation:

1. Fetches the configured RSS feeds in parallel with short timeouts.
2. Normalizes entries to canonical URLs, titles, source, publication time, and
   excerpt. It never scrapes arbitrary article pages.
3. Removes items whose canonical URL already exists in D1.
4. Filters for configured football topics: Messi, Ronaldo, transfers, breaking
   football news, major clubs, star players, Champions League, and Premier
   League.
5. Ranks the remaining items deterministically by source priority, topic match,
   and freshness. It selects one candidate only.
6. Atomically records the run slot and checks the daily Gemini counter before
   calling Gemini. A retried or duplicate Cron execution cannot consume a
   second request for the same slot.
7. Sends the candidate context to Gemini and records the returned draft.

If no eligible article exists, the run is recorded as `no_candidate`; Gemini is
not called. Failed RSS sources do not fail the whole run. The daily cap is a
hard guard, independent of scheduler retries.

Gemini receives only the selected title, excerpt, source name, and canonical
URL. Its prompt requires a factual English social-post draft based solely on
that input, with no invented claims. The source URL is included separately in
the Telegram message so it remains reviewable.

## Telegram approval flow

The Worker sends a private Telegram message containing the English draft and
source link, with `Approve` and `Reject` inline buttons. Button `callback_data`
contains a short draft identifier and intended transition.

For every inbound webhook request, the Worker:

1. Verifies Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
2. Accepts callbacks only from the configured `TELEGRAM_CHAT_ID`.
3. Atomically transitions a `pending` draft to either `approved` or `rejected`.
4. Answers the callback immediately and edits the original Telegram message to
   show the final state.

Repeated presses and late callbacks are idempotent: the stored final state is
kept and no second transition occurs. In this MVP, approval does not post to X;
it creates the durable handoff state needed for that later integration.

## Persistent data

D1 stores only operational metadata:

- `articles`: canonical URL (unique), title, source, published time, selected
  time, and eligibility outcome.
- `drafts`: article reference, generated text, Telegram message ID, and status
  (`pending`, `approved`, `rejected`, or `failed`).
- `scheduled_runs`: UTC run slot (unique), outcome, error summary, and Gemini
  request count.
- `daily_usage`: Asia/Ho_Chi_Minh calendar date and successful Gemini request
  count.

Indexes support URL deduplication, daily quota lookup, and pending-draft lookup.
Historical pruning is explicitly deferred for this MVP: approval records are
retained for auditability, and a retention policy must be approved before any
scheduled deletion is introduced.

## Configuration and secrets

Non-secret configuration is versioned in the Worker configuration: feed URLs,
topic keywords, source priority, and Cron expressions.

Secrets are set in Cloudflare, never committed:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`

Local development uses `.dev.vars`, which is ignored by Git. An example file
documents the required keys without values. Deployment credentials, if GitHub
Actions is later used for CI/CD, are GitHub repository secrets.

## Error handling and observability

- Every external request has a timeout and bounded retry only where repeating is
  safe.
- A failed feed is logged and ignored for that run; a failed Gemini or Telegram
  request marks the run/draft failed without blocking later slots.
- The Worker logs structured, non-secret event metadata: run slot, source
  count, candidate result, draft ID, and error category.
- Token values, article excerpts sent to Gemini, and Telegram request bodies are
  never written to logs.
- Telegram webhook validation failures return an error without processing the
  update.

## Testing

Unit tests cover feed normalization, canonicalization, topic filtering,
ranking, quota/slot idempotency, Gemini prompt construction, and Telegram
callback authorization/state transitions.

Integration-style tests use a local D1 database and mocked RSS, Gemini, and
Telegram HTTP responses. They must prove that: no candidate consumes no Gemini
request; duplicate URLs are not drafted twice; five successful daily requests
block the sixth; unauthorised callbacks cannot change a draft; and approval is
idempotent. No test calls external APIs or requires real secrets.

## Acceptance criteria

- A deployed Worker runs without a personal computer being on.
- It has exactly five configured daily scheduled slots.
- It never makes more than five Gemini generation requests per
  Asia/Ho_Chi_Minh calendar day.
- It sends no Gemini request when no eligible, unprocessed RSS entry exists.
- It never drafts the same canonical article URL twice.
- Telegram approval and rejection work through a verified webhook and survive
  Worker restarts.
- No secret is committed to the repository or emitted in logs.
- The MVP contains no X API credentials or X publishing code.
