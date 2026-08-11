# Google Apps Script Telegram Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route outbound Telegram requests through the verified Google Apps Script relay.

**Architecture:** `TelegramClient` posts a signed JSON envelope to the relay and validates the relay envelope before processing the nested Telegram JSON. The Google Apps Script source is versioned in the repository and secrets remain in Script Properties or Cloudflare secrets.

**Tech Stack:** TypeScript, Cloudflare Workers, Google Apps Script JavaScript, Vitest.

## Global Constraints

- Cloudflare must never make a direct request to `api.telegram.org`.
- Cloudflare must never store `TELEGRAM_BOT_TOKEN` after the relay deployment passes.
- Worker responses and logs must never disclose a bot token, relay secret, raw exception text, request body, or provider response body.
- Preserve the Worker cron schedule, D1 database, 5 Gemini requests/day limit, and inbound Telegram webhook behavior.
- The relay allows exactly `getMe`, `sendMessage`, `answerCallbackQuery`, and `editMessageText`.

---

### Task 1: Implement and test the relay contract in the Worker

**Files:**
- Modify: `src/types.ts`
- Modify: `src/telegram.ts`
- Modify: `src/diagnostic.ts`
- Modify: `src/pipeline.ts`
- Modify: `src/webhook.ts`
- Modify: `test/telegram.test.ts`
- Modify: `test/webhook.test.ts`
- Modify: `test/pipeline.test.ts`
- Modify: `test/config.test.ts`

**Interfaces:**
- Consumes: `TELEGRAM_RELAY_URL`, `TELEGRAM_RELAY_SECRET`, and `TELEGRAM_CHAT_ID` from `Env`.
- Produces: `TelegramClient` requests with JSON `{ secret, method, body }` to the configured relay URL.

- [ ] **Step 1: Write failing tests**

Replace direct Telegram fixtures with relay envelopes. Assert `sendDraft` posts to a relay URL with method `sendMessage`; inspect the parsed body to prove it contains the configured relay secret and method without placing either in the URL. Add failure cases for malformed relay envelopes and nested Telegram HTTP 400. Update the health-probe test to expect relay `getMe`, then update configuration expectations to include the two relay secrets and exclude `TELEGRAM_BOT_TOKEN`.

- [ ] **Step 2: Run focused tests to verify failure**

Run `npm test -- telegram.test.ts webhook.test.ts pipeline.test.ts config.test.ts`. New relay tests must fail because the client still calls Telegram directly and `Env` lacks relay fields.

- [ ] **Step 3: Implement the minimum Worker relay client**

Replace the Telegram URL construction with a relay request. Parse `{ ok: boolean, status?: integer, body?: string }`, return the nested Telegram payload only for a successful relay envelope, and emit fixed errors for malformed or rejected relay responses. Construct `TelegramClient` only with `relayUrl`, `relaySecret`, and `chatId`.

- [ ] **Step 4: Run focused tests to verify success**

Run `npm test -- telegram.test.ts webhook.test.ts pipeline.test.ts config.test.ts`. All selected tests must pass.

- [ ] **Step 5: Commit Task 1**

Stage the Task 1 source and test files and commit with `fix: route telegram through relay`.

### Task 2: Version the relay source and document secure deployment

**Files:**
- Create: `relay/Code.gs`
- Modify: `README.md`

**Interfaces:**
- Consumes Script Properties `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RELAY_SHARED_SECRET`.
- Produces an Apps Script `doPost(e)` accepting `{ secret, method, body }` and returning `{ ok, status?, body? }`.

- [ ] **Step 1: Add relay source and README operating steps**

Add `relay/Code.gs` with the exact allowlist, secret validation, chat ID validation, `UrlFetchApp.fetch`, and JSON output tested manually. Update the README to list the Cloudflare relay secrets, the Google Script Properties, the deploy-as-me/anyone web app configuration, test command without `--request POST`, and the post-deployment command that deletes `TELEGRAM_BOT_TOKEN` from Cloudflare.

- [ ] **Step 2: Run full verification and commit**

Run `npm run typecheck && npm test && npm run lint && git diff --check`; all commands must exit 0. Stage Task 2 files plus these design and plan documents; commit with `docs: add telegram relay deployment`.
