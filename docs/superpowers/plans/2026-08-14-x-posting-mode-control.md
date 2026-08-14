# X Posting Mode Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private `/xmode` Telegram control panel backed by a durable Supabase singleton, with `OFF` available now and `MANUAL`/`AUTO` visibly locked.

**Architecture:** A new `bot_settings` singleton stores the three-value domain enum while a dedicated repository interface isolates settings access from the scheduled pipeline repository contract. The existing Telegram webhook authenticates first, routes message and callback updates by type, and delegates panel rendering to `TelegramClient`; the current Approve/Reject path remains unchanged.

**Tech Stack:** TypeScript 7, Supabase Edge Functions/Deno, Supabase Postgres with RLS, `@supabase/supabase-js` 2.110.8, Telegram Bot API, Vitest 4.1.10, pgTAP.

## Global Constraints

- The only selectable mode in this phase is `off`; `manual` and `auto` remain locked.
- The default and rollback-safe mode is `off`.
- `/xmode` and `xm:*` callbacks are authorized only by `TELEGRAM_CHAT_ID`; Telegram usernames are not trusted.
- Existing `a:<draft-id>` and `r:<draft-id>` behavior must not change.
- Validate `TELEGRAM_WEBHOOK_SECRET` before reading unrelated environment variables, parsing privileged state, calling Supabase, or calling Telegram.
- Every external Telegram request retains the existing 8,000 ms timeout.
- Never log or return secrets, Telegram payload text, draft content, or provider response bodies.
- Do not add X credentials, X API calls, X composer links, or X-specific copy generation in this phase.
- Use test-driven development: every production behavior begins with a focused failing test.
- Commit messages use `<type>: <subject>` with one of `feat`, `fix`, `refactor`, or `chore`.

---

## File Structure

- Create `supabase/migrations/202608140001_x_posting_mode.sql`: singleton table, default row, constraints, RLS, and grants.
- Create `supabase/tests/database/0002_x_posting_mode.test.sql`: pgTAP coverage for shape, singleton constraints, default, and privileges.
- Modify `supabase/functions/_shared/domain-types.ts`: define `XPostingMode`.
- Modify `supabase/functions/_shared/database.types.ts`: add generated-style `bot_settings` row/insert/update types.
- Modify `supabase/functions/_shared/repository.ts`: define `XPostingModeRepository` and implement strict singleton reads/writes.
- Modify `test/supabase/repository.integration.test.ts`: verify durable reads/writes against local Supabase.
- Modify `supabase/functions/_shared/telegram.ts`: render/send/edit the X mode panel and subscribe the webhook to messages.
- Modify `test/supabase/telegram-direct.test.ts`: assert exact Telegram request envelopes.
- Modify `supabase/functions/telegram-webhook/handler.ts`: route `/xmode`, `xm:*`, and existing draft callbacks.
- Modify `test/supabase/telegram-webhook.test.ts`: cover authentication, routing, locking, persistence, failures, and regressions.
- Modify `test/supabase/telegram-diagnostic.test.ts`: require both Telegram update types during webhook setup.
- Modify `scripts/configure-telegram-webhook.mjs`: request both Telegram update types in the operator helper.
- Modify `test/supabase/runbook-security.test.ts`: lock the helper/runbook contract where relevant.
- Modify `README.md`: document `/xmode`, deployment order, verification, and the locked modes.

---

### Task 1: Durable X Posting Mode Setting

**Files:**
- Create: `supabase/migrations/202608140001_x_posting_mode.sql`
- Create: `supabase/tests/database/0002_x_posting_mode.test.sql`
- Modify: `supabase/functions/_shared/domain-types.ts`
- Modify: `supabase/functions/_shared/database.types.ts`
- Modify: `supabase/functions/_shared/repository.ts`
- Modify: `test/supabase/repository.integration.test.ts`

**Interfaces:**
- Produces: `type XPostingMode = "off" | "manual" | "auto"`.
- Produces: `XPostingModeRepository.getXPostingMode(): Promise<XPostingMode>`.
- Produces: `XPostingModeRepository.setXPostingMode(mode: XPostingMode, now: Date): Promise<XPostingMode>`.
- Produces: `SupabaseBotRepository` implementing both `BotRepository` and `XPostingModeRepository` without adding settings methods to the scheduled pipeline's `BotRepository` interface.

- [ ] **Step 1: Add a failing pgTAP schema contract**

Create `supabase/tests/database/0002_x_posting_mode.test.sql` with explicit assertions:

```sql
begin;

select plan(12);

select has_table('public', 'bot_settings', 'bot settings table exists');
select has_column('public', 'bot_settings', 'id', 'singleton id exists');
select has_column('public', 'bot_settings', 'x_posting_mode', 'X mode exists');
select has_column('public', 'bot_settings', 'updated_at', 'update timestamp exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.bot_settings'::regclass),
  'bot settings has RLS enabled'
);
select is((select count(*) from public.bot_settings), 1::bigint, 'one setting row exists');
select is(
  (select x_posting_mode from public.bot_settings where id = 1),
  'off',
  'X mode defaults to off'
);
select throws_ok(
  $$insert into public.bot_settings(id, x_posting_mode) values (2, 'off')$$,
  '23514', null, 'singleton id is constrained to one'
);
select throws_ok(
  $$update public.bot_settings set x_posting_mode = 'invalid' where id = 1$$,
  '23514', null, 'X mode values are constrained'
);
select ok(
  not has_table_privilege('anon', 'public.bot_settings', 'SELECT'),
  'anon cannot read bot settings'
);
select ok(
  not has_table_privilege('authenticated', 'public.bot_settings', 'UPDATE'),
  'authenticated cannot update bot settings'
);
select ok(
  has_table_privilege('service_role', 'public.bot_settings', 'SELECT') and
  has_table_privilege('service_role', 'public.bot_settings', 'UPDATE'),
  'service role can read and update bot settings'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run the database test and verify RED**

Run:

```bash
npm run supabase:start
npm run test:db
```

Expected: FAIL because `public.bot_settings` does not exist.

- [ ] **Step 3: Add the minimal migration**

Create `supabase/migrations/202608140001_x_posting_mode.sql`:

```sql
create table public.bot_settings (
  id smallint primary key check (id = 1),
  x_posting_mode text not null check (x_posting_mode in ('off', 'manual', 'auto')),
  updated_at timestamptz not null
);

insert into public.bot_settings(id, x_posting_mode, updated_at)
values (1, 'off', now());

alter table public.bot_settings enable row level security;

revoke all on table public.bot_settings from public, anon, authenticated;
grant select, update on table public.bot_settings to service_role;
```

- [ ] **Step 4: Reset local Supabase and verify the schema GREEN**

Run:

```bash
npx supabase db reset
npm run test:db
```

Expected: all database tests PASS, including 12 assertions in `0002_x_posting_mode.test.sql`.

- [ ] **Step 5: Add failing repository integration coverage**

Add the exact domain import and test to `test/supabase/repository.integration.test.ts`:

```ts
import type { Article, XPostingMode } from "../../supabase/functions/_shared/domain-types";

it("reads and durably changes the singleton X posting mode", async () => {
  await expect(repository.getXPostingMode()).resolves.toBe("off");

  const changedAt = new Date("2026-08-12T01:10:00.000Z");
  await expect(repository.setXPostingMode("manual", changedAt)).resolves.toBe("manual");
  await expect(repository.getXPostingMode()).resolves.toBe("manual");

  const { data, error } = await client
    .from("bot_settings")
    .select("x_posting_mode,updated_at")
    .eq("id", 1)
    .single();
  expect(error).toBeNull();
  expect(data).toEqual({
    x_posting_mode: "manual" satisfies XPostingMode,
    updated_at: changedAt.toISOString(),
  });
});
```

Reset the singleton in `beforeEach` using an `update` to `off`; never delete the required row.

- [ ] **Step 6: Run the focused integration test and verify RED**

Run:

```bash
npm run test:integration
```

Expected: FAIL because `XPostingMode`, the generated table type, and repository methods do not exist.

- [ ] **Step 7: Add strict domain, generated-style table types, and repository methods**

Add to `domain-types.ts`:

```ts
export type XPostingMode = "off" | "manual" | "auto";
```

Add the `bot_settings` table to `Database["public"]["Tables"]` with:

```ts
bot_settings: {
  Row: { id: number; updated_at: string; x_posting_mode: string }
  Insert: { id: number; updated_at: string; x_posting_mode: string }
  Update: { id?: number; updated_at?: string; x_posting_mode?: string }
  Relationships: []
}
```

Add to `repository.ts`:

```ts
export interface XPostingModeRepository {
  getXPostingMode(): Promise<XPostingMode>;
  setXPostingMode(mode: XPostingMode, now: Date): Promise<XPostingMode>;
}
```

Implement both methods on `SupabaseBotRepository`. `getXPostingMode` must query `id = 1` with `.single()`. `setXPostingMode` must update only `id = 1`, select `x_posting_mode`, and use `.single()`. Both must pass the result through:

```ts
function requireXPostingMode(value: unknown, operation: string): XPostingMode {
  if (value === "off" || value === "manual" || value === "auto") return value;
  throwRepositoryError(operation);
}
```

Use redacted operation categories `get_x_posting_mode` and `set_x_posting_mode`.

- [ ] **Step 8: Run focused and full repository verification**

Run:

```bash
npm run test:integration
npm run typecheck
npm test
```

Expected: integration test, typecheck, and all unit tests PASS.

- [ ] **Step 9: Commit the durable setting**

```bash
git add supabase/migrations/202608140001_x_posting_mode.sql \
  supabase/tests/database/0002_x_posting_mode.test.sql \
  supabase/functions/_shared/domain-types.ts \
  supabase/functions/_shared/database.types.ts \
  supabase/functions/_shared/repository.ts \
  test/supabase/repository.integration.test.ts
git commit -m "feat: add x posting mode setting"
```

---

### Task 2: Telegram Mode Panel and Webhook Subscription

**Files:**
- Modify: `supabase/functions/_shared/telegram.ts`
- Modify: `test/supabase/telegram-direct.test.ts`
- Modify: `test/supabase/telegram-diagnostic.test.ts`
- Modify: `scripts/configure-telegram-webhook.mjs`

**Interfaces:**
- Consumes: `XPostingMode` from Task 1.
- Produces: `TelegramClient.sendXPostingModePanel(mode: XPostingMode): Promise<number>`.
- Produces: `TelegramClient.editXPostingModePanel(messageId: number, mode: XPostingMode): Promise<void>`.
- Changes: `TelegramClient.setWebhook()` registers `allowed_updates: ["message", "callback_query"]`.

- [ ] **Step 1: Add failing exact-envelope tests for the mode panel**

Add two tests to `test/supabase/telegram-direct.test.ts` asserting these request bodies:

```ts
expect(JSON.parse(String(sendInit?.body))).toEqual({
  chat_id: "1331364954",
  text: "X posting mode: OFF",
  reply_markup: {
    inline_keyboard: [[
      { text: "OFF ✓", callback_data: "xm:off" },
      { text: "MANUAL 🔒", callback_data: "xm:manual" },
      { text: "AUTO 🔒", callback_data: "xm:auto" },
    ]],
  },
});

expect(JSON.parse(String(editInit?.body))).toEqual({
  chat_id: "1331364954",
  message_id: 500,
  text: "X posting mode: OFF",
  reply_markup: {
    inline_keyboard: [[
      { text: "OFF ✓", callback_data: "xm:off" },
      { text: "MANUAL 🔒", callback_data: "xm:manual" },
      { text: "AUTO 🔒", callback_data: "xm:auto" },
    ]],
  },
});
```

Also change the existing webhook expectation in both Telegram client and diagnostic tests to:

```ts
allowed_updates: ["message", "callback_query"]
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- test/supabase/telegram-direct.test.ts test/supabase/telegram-diagnostic.test.ts
```

Expected: FAIL because panel methods are absent and webhook registration still excludes `message`.

- [ ] **Step 3: Implement one shared panel renderer and client methods**

Add a private renderer in `telegram.ts`:

```ts
function xPostingModePanel(mode: XPostingMode): Record<string, unknown> {
  return {
    text: `X posting mode: ${mode.toUpperCase()}`,
    reply_markup: {
      inline_keyboard: [[
        { text: mode === "off" ? "OFF ✓" : "OFF", callback_data: "xm:off" },
        { text: "MANUAL 🔒", callback_data: "xm:manual" },
        { text: "AUTO 🔒", callback_data: "xm:auto" },
      ]],
    },
  };
}
```

`sendXPostingModePanel` calls `sendMessage`, validates and returns `message_id`. `editXPostingModePanel` calls `editMessageText` with the provided message ID. Reuse the existing `request` method so the eight-second timeout and error sanitization remain unchanged.

Change both runtime webhook setup paths to `allowed_updates: ["message", "callback_query"]`.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
npm test -- test/supabase/telegram-direct.test.ts test/supabase/telegram-diagnostic.test.ts
npm run typecheck
npm test
```

Expected: focused and full suites PASS.

- [ ] **Step 5: Commit the Telegram panel**

```bash
git add supabase/functions/_shared/telegram.ts \
  test/supabase/telegram-direct.test.ts \
  test/supabase/telegram-diagnostic.test.ts \
  scripts/configure-telegram-webhook.mjs
git commit -m "feat: add telegram x mode panel"
```

---

### Task 3: Authenticated `/xmode` Routing and Locked Controls

**Files:**
- Modify: `supabase/functions/telegram-webhook/handler.ts`
- Modify: `test/supabase/telegram-webhook.test.ts`

**Interfaces:**
- Consumes: `XPostingModeRepository` from Task 1.
- Consumes: `sendXPostingModePanel`, `editXPostingModePanel`, and `answerCallback` from Task 2.
- Changes: `TelegramWebhookDependencies.repository` becomes `BotRepository & XPostingModeRepository`.
- Changes: `TelegramWebhookDependencies.now?: () => Date`, defaulting to `() => new Date()`.

- [ ] **Step 1: Extend the in-memory repository and request builders in tests**

Add deterministic mode state to `MemoryRepository`:

```ts
xPostingMode: XPostingMode = "off";
modeReads = 0;
modeWrites: Array<{ mode: XPostingMode; now: Date }> = [];

async getXPostingMode(): Promise<XPostingMode> {
  this.modeReads += 1;
  return this.xPostingMode;
}

async setXPostingMode(mode: XPostingMode, now: Date): Promise<XPostingMode> {
  this.modeWrites.push({ mode, now });
  this.xPostingMode = mode;
  return mode;
}
```

Add a `messageRequest(text, chatId, secret)` builder for Telegram `message` updates and allow `callbackRequest` to emit `xm:*` data with a settings panel message ID.

```ts
function messageRequest(
  text: string,
  chatId = 1_331_364_954,
  secret = "webhook-test-secret",
): Request {
  return new Request("https://project.supabase.co/functions/v1/telegram-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify({
      update_id: 101,
      message: {
        message_id: 499,
        text,
        chat: { id: chatId, type: "private" },
      },
    }),
  });
}
```

- [ ] **Step 2: Add failing command-routing tests**

Add these separate tests using the existing `ENV`, `MemoryRepository`, and `successfulTelegram` helpers:

```ts
it("renders the durable X mode for an authorized /xmode command", async () => {
  const repository = new MemoryRepository();
  const fetcher = successfulTelegram();
  const handler = createTelegramWebhookHandler({
    readEnv: (name) => ENV.get(name), fetcher, repository,
  });

  const response = await handler(messageRequest("/xmode"));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: "ok", mode: "off" });
  expect(repository.modeReads).toBe(1);
  expect(repository.modeWrites).toEqual([]);
  const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
  expect(String(url)).toBe("https://api.telegram.org/bottest-token/sendMessage");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    chat_id: "1331364954",
    text: "X posting mode: OFF",
  });
});

it("ignores ordinary messages without reading settings", async () => {
  const repository = new MemoryRepository();
  const fetcher = successfulTelegram();
  const handler = createTelegramWebhookHandler({
    readEnv: (name) => ENV.get(name), fetcher, repository,
  });

  const response = await handler(messageRequest("hello"));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: "ignored" });
  expect(repository.modeReads).toBe(0);
  expect(repository.modeWrites).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects a foreign /xmode command without reading settings", async () => {
  const repository = new MemoryRepository();
  const fetcher = successfulTelegram();
  const handler = createTelegramWebhookHandler({
    readEnv: (name) => ENV.get(name), fetcher, repository,
  });

  const response = await handler(messageRequest("/xmode", 999));

  expect(response.status).toBe(403);
  expect(repository.modeReads).toBe(0);
  expect(repository.modeWrites).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});
```

Use exact response bodies and exact Telegram request payloads, not call-count-only assertions.

- [ ] **Step 3: Run the command tests and verify RED**

Run:

```bash
npm test -- test/supabase/telegram-webhook.test.ts
```

Expected: FAIL because message updates are currently ignored and settings methods are not used.

- [ ] **Step 4: Implement authenticated update parsing and `/xmode` routing**

Split parsing into bounded helpers:

```ts
interface ParsedMessage { chatId: string; text: string }

function isXModeCommand(text: string): boolean {
  return /^\/xmode(?:@[A-Za-z0-9_]{5,32})?$/u.test(text.trim());
}
```

After webhook-secret validation and JSON parsing, identify `message` versus `callback_query`. Load bot token/chat ID, reject a foreign chat, then for `/xmode`:

1. Read `getXPostingMode()`.
2. Construct `TelegramClient`.
3. Call `sendXPostingModePanel(mode)`.
4. Return `{ status: "ok", mode }`.

Repository failure returns `{ status: "database_error" }` with 500. Provider failure returns `{ status: "provider_error" }` with 502. Ordinary messages return `{ status: "ignored" }` without a repository/provider call.

- [ ] **Step 5: Add failing callback tests for OFF and locked modes**

Add tests that prove:

- `xm:off` while stored mode is `off` answers `Already OFF`, performs zero writes, and does not edit the panel.
- `xm:off` while stored mode is `manual` writes `off` with the injected timestamp, answers `X posting mode set to OFF`, and edits the panel to `OFF`.
- `xm:manual` answers `Manual mode is coming soon` and performs zero reads/writes.
- `xm:auto` answers `Auto mode is not configured` and performs zero reads/writes.
- A foreign settings callback returns 403 before any setting access.
- A provider failure after a successful transition to `off` returns 502 while the in-memory mode remains `off`.
- Existing `a:*`, `r:*`, invalid callback, and idempotent decision tests remain unchanged and green.

Use these exact state assertions for the writable and locked paths:

```ts
it("uses xm:off as a durable emergency stop", async () => {
  const repository = new MemoryRepository();
  repository.xPostingMode = "manual";
  const fetcher = successfulTelegram();
  const now = new Date("2026-08-14T05:00:00.000Z");
  const handler = createTelegramWebhookHandler({
    readEnv: (name) => ENV.get(name), fetcher, repository, now: () => now,
  });

  const response = await handler(callbackRequest(7, { data: "xm:off", messageId: 500 }));

  expect(response.status).toBe(200);
  expect(repository.xPostingMode).toBe("off");
  expect(repository.modeWrites).toEqual([{ mode: "off", now }]);
  expect(vi.mocked(fetcher).mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual([
    "answerCallbackQuery", "editMessageText",
  ]);
});

it.each([
  ["xm:manual", "Manual mode is coming soon", "manual"],
  ["xm:auto", "Auto mode is not configured", "auto"],
] as const)("keeps %s locked", async (data, answer, mode) => {
  const repository = new MemoryRepository();
  const fetcher = successfulTelegram();
  const handler = createTelegramWebhookHandler({
    readEnv: (name) => ENV.get(name), fetcher, repository,
  });

  const response = await handler(callbackRequest(7, { data }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: "locked", mode });
  expect(repository.modeReads).toBe(0);
  expect(repository.modeWrites).toEqual([]);
  expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0]?.[1]?.body))).toEqual({
    callback_query_id: "callback-query-1",
    text: answer,
  });
});
```

- [ ] **Step 6: Run callback tests and verify RED**

Run:

```bash
npm test -- test/supabase/telegram-webhook.test.ts
```

Expected: new `xm:*` tests FAIL because callbacks are still rejected by the draft-only parser.

- [ ] **Step 7: Implement the settings callback state machine**

Route `xm:*` before the draft action regex:

```ts
if (callback.data === "xm:manual") {
  await telegram.answerCallback(callback.id, "Manual mode is coming soon");
  return Response.json({ status: "locked", mode: "manual" });
}
if (callback.data === "xm:auto") {
  await telegram.answerCallback(callback.id, "Auto mode is not configured");
  return Response.json({ status: "locked", mode: "auto" });
}
if (callback.data === "xm:off") {
  const current = await dependencies.repository.getXPostingMode();
  if (current === "off") {
    await telegram.answerCallback(callback.id, "Already OFF");
    return Response.json({ status: "ok", mode: "off" });
  }
  await dependencies.repository.setXPostingMode("off", now());
  // Do not roll this durable emergency stop back if either Telegram call fails.
  await telegram.answerCallback(callback.id, "X posting mode set to OFF");
  await telegram.editXPostingModePanel(callback.messageId, "off");
  return Response.json({ status: "ok", mode: "off" });
}
```

Wrap repository and provider operations separately so response categories stay `database_error` versus `provider_error`. Never include caught error text in a response or log.

- [ ] **Step 8: Run focused and full webhook verification**

Run:

```bash
npm test -- test/supabase/telegram-webhook.test.ts
npm run typecheck
npm test
```

Expected: all webhook tests, all existing draft tests, typecheck, and the full suite PASS.

- [ ] **Step 9: Commit authenticated mode routing**

```bash
git add supabase/functions/telegram-webhook/handler.ts \
  test/supabase/telegram-webhook.test.ts
git commit -m "feat: add telegram x mode controls"
```

---

### Task 4: Runbook, Security Regression, and Release Gate

**Files:**
- Modify: `README.md`
- Modify: `test/supabase/runbook-security.test.ts`

**Interfaces:**
- Consumes: migration, webhook behavior, and setup helper from Tasks 1–3.
- Produces: operator sequence for migration, deployment, webhook re-registration, `/xmode` verification, and rollback.

- [ ] **Step 1: Add failing runbook regression assertions**

Extend `test/supabase/runbook-security.test.ts` to require all of these literal contracts:

```ts
expect(readme).toContain("/xmode");
expect(readme).toContain("MANUAL 🔒");
expect(readme).toContain("AUTO 🔒");
expect(webhookHelper).toContain('allowed_updates: ["message", "callback_query"]');
```

Retain every existing assertion that secrets arrive over standard input and never appear in child command arguments.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- test/supabase/runbook-security.test.ts
```

Expected: FAIL because README does not document the panel or locked-mode verification.

- [ ] **Step 3: Document exact deployment and verification steps**

Update README with this ordered release gate:

```text
1. npx supabase db push
2. Verify public.bot_settings has exactly id=1 and x_posting_mode=off.
3. npx supabase functions deploy telegram-webhook --use-api
4. Re-run scripts/configure-telegram-webhook.mjs through the existing stdin-only credential flow.
5. Send /xmode in the configured private Telegram chat.
6. Require OFF ✓, MANUAL 🔒, and AUTO 🔒.
7. Press all three buttons; require the database mode to remain off.
8. Approve one controlled draft and require the existing approved state transition.
```

Document that rollback redeploys the prior webhook and re-registers `allowed_updates: ["callback_query"]`; the `bot_settings` row remains safely at `off` and is not dropped.

- [ ] **Step 4: Run the complete verification gate**

Run from a started, reset local Supabase stack:

```bash
npx supabase db reset
npm run typecheck
npm test
npm run test:db
npm run test:integration
npx supabase db lint --level warning
git diff --check
```

Expected: every command exits 0; no TypeScript, Vitest, pgTAP, integration, lint, or whitespace failure remains.

- [ ] **Step 5: Perform a scoped diff review**

Inspect:

```bash
git status --short
git diff --stat HEAD~3
git diff HEAD~3 -- \
  supabase/migrations \
  supabase/functions/_shared \
  supabase/functions/telegram-webhook \
  scripts/configure-telegram-webhook.mjs \
  test/supabase \
  supabase/tests/database \
  README.md
```

Require: no X API call, no composer URL, no secret value, no logging of payload text, no behavior change to scheduled execution, and no selectable `manual` or `auto` callback.

- [ ] **Step 6: Commit the runbook and release gate**

```bash
git add README.md test/supabase/runbook-security.test.ts
git commit -m "chore: document x mode controls"
```

- [ ] **Step 7: Stop local services after verification**

```bash
npm run supabase:stop
```

Expected: local Supabase containers stop cleanly; this does not affect the hosted project.
