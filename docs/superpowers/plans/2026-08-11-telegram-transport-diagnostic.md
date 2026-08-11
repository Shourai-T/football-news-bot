# Telegram Transport Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return a safe, stable transport classification from the temporary Telegram health probe.

**Architecture:** Preserve the internal reason for a Telegram request rejection in a typed client error. The diagnostic route maps that reason to a response field while retaining redacted pipeline errors and never serializing the original exception.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest.

## Global Constraints

- Never return or log a raw exception message, Telegram URL, bot token, request body, or response body.
- Preserve existing pipeline error categories: `telegram_timeout` and `telegram_network_error`.
- The endpoint remains `POST /internal/telegram-health`, requires `DIAGNOSTIC_SECRET`, does not invoke Gemini, and does not send Telegram messages.

---

### Task 1: Add safe transport classifications to the health probe

**Files:**
- Modify: `src/telegram.ts`
- Modify: `src/diagnostic.ts`
- Modify: `test/webhook.test.ts`

**Interfaces:**
- Produces: diagnostic responses shaped as `{ status: "unavailable", category: "telegram_timeout" | "telegram_network_error", transport: "timeout" | "fetch_rejected" }`.
- Preserves: pipeline consumers receive the existing error messages from `TelegramClient`.

- [x] **Step 1: Write the failing route tests**

Test a rejected fetch with a secret-looking error message. The expected response is `{ status: "unavailable", category: "telegram_network_error", transport: "fetch_rejected" }`; response and structured log expectations must not contain the secret-looking text. Add a second test with an aborted fetch that expects `transport: "timeout"`.

- [x] **Step 2: Run the focused test to verify it fails**

Run `npm test -- webhook.test.ts`. The new assertions must fail because the current response has no `transport` property.

- [x] **Step 3: Write the minimal implementation**

Add a `TelegramRequestError` that stores only `timeout` or `fetch_rejected`. Throw it from the request rejection path while preserving the existing message strings. The diagnostic handler reads only that typed field, maps unknown errors to `fetch_rejected`, and returns it as `transport`.

- [x] **Step 4: Run the focused test to verify it passes**

Run `npm test -- webhook.test.ts`. All webhook tests must pass.

- [x] **Step 5: Run full verification and commit**

Run `npm run typecheck && npm test && npm run lint && git diff --check`; all commands must exit 0. Stage `src/telegram.ts`, `src/diagnostic.ts`, `test/webhook.test.ts`, and these design and plan documents; commit with `fix: classify telegram transport failures`.
