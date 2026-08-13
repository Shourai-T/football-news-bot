# Supabase Platform Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare Worker, D1, and Google Apps Script relay runtime with Supabase Edge Functions, Postgres, and Cron while preserving the five-draft daily workflow and Telegram approval behavior.

**Architecture:** Two Deno-compatible TypeScript Edge Functions share focused domain and repository modules. `scheduled-pipeline` is authenticated by a dedicated scheduled-function secret and performs RSS selection, transactional Gemini quota reservation, generation, and direct Telegram delivery; `telegram-webhook` validates Telegram's secret header and performs idempotent Postgres draft transitions. A viability function proves direct Supabase-to-Telegram connectivity before database or webhook cutover.

**Tech Stack:** Node.js 22+, TypeScript 7.0.2, Vitest 4.1.10, Deno 2.9+, Supabase CLI 2.110.0, Supabase JS 2.110.8, Supabase Edge Functions, Postgres, pgTAP, `pg_cron`, `pg_net`, Vault, fast-xml-parser 5.10.1, Telegram Bot API, Gemini REST API.

## Global Constraints

- Preserve the Vietnam schedule `08:07`, `11:07`, `14:07`, `17:07`, and `20:07`, represented in UTC as `7 1,4,7,10,13 * * *`.
- Make no more than five Gemini reservations per `Asia/Ho_Chi_Minh` calendar date, including concurrent and retried calls.
- Use only the currently versioned, verified HTTPS RSS/Atom feeds; do not scrape article pages.
- Call Telegram directly from Supabase. Do not introduce another relay or fallback proxy.
- Do not switch the Telegram webhook, enable Supabase Cron, disable Cloudflare Cron, or remove relay resources until the viability gate passes.
- Do not delete the remote D1 database. Inspect and reconcile its row counts before cutover.
- Do not introduce X credentials, OAuth, credits, or publishing calls in this migration.
- Never place secret values in Git, command arguments, shell history, logs, test fixtures, or chat. Enter hosted secrets through the Supabase dashboard.
- Keep every external request timeout at 8 seconds or less; keep an entire pipeline invocation below the Supabase Free 150-second wall-clock limit.
- Keep public tables behind RLS with no public policies. Edge Functions access them only through the project secret key.
- Docker Desktop is installed but its daemon is currently stopped; start it before local Supabase integration tests.
- Deno is not currently installed; install Deno 2.9 or newer through Homebrew only after the operator approves that machine-level change.

---

### Task 1: Supabase scaffold and Telegram viability function

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `tsconfig.supabase.json`
- Create: `supabase/config.toml`
- Create: `supabase/functions/deno.json`
- Create: `supabase/functions/.env.example`
- Create: `supabase/functions/_shared/runtime-env.ts`
- Create: `supabase/functions/_shared/telegram.ts`
- Create: `supabase/functions/telegram-diagnostic/handler.ts`
- Create: `supabase/functions/telegram-diagnostic/index.ts`
- Test: `test/supabase/telegram-direct.test.ts`
- Test: `test/supabase/telegram-diagnostic.test.ts`

**Interfaces:**
- Produces: `readRequiredEnv(name, read)`, `TelegramClient`, `createTelegramDiagnosticHandler(dependencies)`.
- `TelegramClient` initially exposes `checkHealth(): Promise<void>` and `sendDiagnostic(): Promise<number>`; later tasks add draft and callback methods without changing constructor behavior.
- `createTelegramDiagnosticHandler` accepts `{ readEnv, fetcher }` and returns `(request: Request) => Promise<Response>`.

- [ ] **Step 1: Pin Supabase dependencies and add scripts**

Request approval for the machine-level Deno installation, then run:

```bash
brew install deno
deno --version
```

Expected: Deno is at least `2.9.0`. Stop if Homebrew installs an older release.

Run:

```bash
npm install --save-exact @supabase/supabase-js@2.110.8
npm install --save-dev --save-exact supabase@2.110.0
```

Add these scripts without removing the existing Worker scripts yet:

```json
{
  "supabase:start": "supabase start",
  "supabase:stop": "supabase stop",
  "test:db": "supabase test db",
  "test:supabase": "vitest run test/supabase",
  "typecheck:supabase": "tsc --noEmit -p tsconfig.supabase.json"
}
```

Expected: `npx supabase --version` prints `2.110.0` and the existing test suite remains installable.

- [ ] **Step 2: Create the failing direct-Telegram tests**

Write tests that prove the client constructs `https://api.telegram.org/bot${botToken}/${method}`, sends JSON directly, rejects non-2xx and `{ ok: false }` responses with sanitized categories, and never returns or logs a bot token.

```ts
it("calls Telegram directly for getMe", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({ ok: true, result: { id: 1 } }),
  );
  const client = new TelegramClient(
    { botToken: "test-token", chatId: "1331364954" },
    fetcher,
  );

  await client.checkHealth();

  expect(fetcher).toHaveBeenCalledWith(
    "https://api.telegram.org/bottest-token/getMe",
    expect.objectContaining({ method: "POST", redirect: "error" }),
  );
});

it("sends one labelled diagnostic message", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({ ok: true, result: { message_id: 77 } }),
  );
  const client = new TelegramClient(
    { botToken: "test-token", chatId: "1331364954" },
    fetcher,
  );

  await expect(client.sendDiagnostic()).resolves.toBe(77);
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(request).toEqual({
    chat_id: "1331364954",
    text: "Supabase Telegram diagnostic succeeded.",
  });
});
```

- [ ] **Step 3: Run the focused tests to verify RED**

Run:

```bash
npm test -- test/supabase/telegram-direct.test.ts test/supabase/telegram-diagnostic.test.ts
```

Expected: FAIL because the Supabase shared client and handler do not exist.

- [ ] **Step 4: Add the minimal direct Telegram client and runtime reader**

Implement these exact public contracts:

```ts
export type RuntimeEnvReader = (name: string) => string | undefined;

export function readRequiredEnv(
  name: string,
  read: RuntimeEnvReader,
): string {
  const value = read(name)?.trim();
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

export interface DirectTelegramConfig {
  botToken: string;
  chatId: string;
}

export class TelegramClient {
  constructor(
    private readonly config: DirectTelegramConfig,
    private readonly fetcher: typeof fetch,
  ) {}

  checkHealth(): Promise<void>;
  sendDiagnostic(): Promise<number>;
}
```

The private request method must use `AbortSignal.timeout(8_000)`, `redirect: "error"`, `content-type: application/json`, validate both HTTP status and Telegram's `ok` field, and throw only these categories: `telegram_timeout`, `telegram_network_error`, ``telegram_api_error:${status}``, or `telegram_invalid_response`.

- [ ] **Step 5: Add the diagnostic handler and tests**

The handler accepts only `POST`, compares `X-Scheduled-Secret` with `SCHEDULED_FUNCTION_SECRET`, accepts exactly `{"operation":"getMe"}` or `{"operation":"sendMessage"}`, and returns only generic success data:

```ts
export interface DiagnosticDependencies {
  readEnv: RuntimeEnvReader;
  fetcher: typeof fetch;
}

export function createTelegramDiagnosticHandler(
  dependencies: DiagnosticDependencies,
): (request: Request) => Promise<Response>;
```

Required assertions:

```ts
expect((await unauthorized.json())).toEqual({ status: "unauthorized" });
expect(fetcher).not.toHaveBeenCalled();
expect((await success.json())).toEqual({ status: "ok", operation: "getMe" });
expect(await success.text()).not.toContain("test-token");
```

`index.ts` is only a Deno entrypoint:

```ts
import { createTelegramDiagnosticHandler } from "./handler.ts";

export default {
  fetch: createTelegramDiagnosticHandler({
    readEnv: (name) => Deno.env.get(name),
    fetcher: fetch,
  }),
};
```

- [ ] **Step 6: Add Supabase configuration and secret template**

Initialize the project-local Supabase layout once:

```bash
npx supabase init
```

Configure all current functions with gateway JWT verification disabled because each endpoint performs its own provider-specific authentication:

```toml
project_id = "football-news-bot"

[functions.telegram-diagnostic]
verify_jwt = false

[functions.telegram-webhook]
verify_jwt = false

[functions.scheduled-pipeline]
verify_jwt = false
```

Pin Deno imports:

```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.110.8",
    "fast-xml-parser": "npm:fast-xml-parser@5.10.1"
  }
}
```

`supabase/functions/.env.example` lists empty names only:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
GEMINI_API_KEY=
GEMINI_MODEL=
SCHEDULED_FUNCTION_SECRET=
```

Ignore `supabase/functions/.env`, `supabase/functions/.env.local`, `.supabase/`, and any `supabase/.temp/` output.

Use a separate TypeScript project while the Cloudflare runtime still exists:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["supabase/functions/**/*.ts", "test/supabase/**/*.ts"],
  "exclude": ["supabase/functions/*/index.ts"]
}
```

- [ ] **Step 7: Verify locally**

Run:

```bash
npm run typecheck
npm run typecheck:supabase
npm test -- test/supabase/telegram-direct.test.ts test/supabase/telegram-diagnostic.test.ts
deno check supabase/functions/telegram-diagnostic/index.ts
npx supabase functions serve telegram-diagnostic --env-file supabase/functions/.env.local
```

Expected: typecheck and tests PASS; after Docker Desktop is running, the local function starts without a bundle error. Stop the serve process after the startup check.

- [ ] **Step 8: Commit the local viability implementation**

```bash
git add package.json package-lock.json .gitignore tsconfig.supabase.json supabase test/supabase
git commit -m "feat: add supabase telegram viability function"
```

- [ ] **Step 9: Execute the hosted viability gate**

Operator actions:

1. Create one Supabase Free project in the closest available region to Vietnam.
2. Run `npx supabase login`, then interactively read the non-secret project ref and run `npx supabase link --project-ref "$SUPABASE_PROJECT_REF"`.
3. In Supabase Dashboard → Edge Functions → Secrets, add the six names from `.env.example`; use the already proven Gemini model `gemini-3.5-flash-lite`.
4. Deploy with `npx supabase functions deploy telegram-diagnostic --use-api`.
5. Read `SCHEDULED_FUNCTION_SECRET` silently into a shell variable, call the live function once with `getMe` and once with `sendMessage`, then unset it.

Expected: both calls return generic HTTP 200 responses and Telegram receives exactly one diagnostic message. If either call fails, stop the entire migration and do not add a relay.

- [ ] **Step 10: Prove inbound Telegram callback delivery**

Before starting Task 2, extend the diagnostic client with a controlled
`sendWebhookProbe` operation and deploy a temporary minimal
`telegram-webhook` handler. The probe message contains exactly one
`callback_data: "v:1"` button. The webhook must validate
`X-Telegram-Bot-Api-Secret-Token`, the configured private chat, and the exact
probe callback before calling Telegram `answerCallbackQuery`. It performs no
database mutation and no Gemini request.

Run the focused webhook tests first, then deploy both functions. Record the
current Telegram webhook URL, register the Supabase webhook with
`allowed_updates=["callback_query"]`, send the controlled probe, and click the
button once. Confirm the callback acknowledgement and inspect sanitized Edge
Function logs. Restore the recorded webhook URL if any inbound check fails.

Expected: Telegram displays `Supabase webhook received.`, the Supabase webhook
log shows one successful request without request bodies or credentials, and
only then may Task 2 begin.

---

### Task 2: Postgres schema and transactional invariants

**Files:**
- Create: `supabase/migrations/202608120001_bot_schema.sql`
- Create: `supabase/tests/database/0001_bot_schema.test.sql`

**Interfaces:**
- Produces tables: `articles`, `drafts`, `scheduled_runs`, `daily_usage`.
- Produces RPC: `reserve_gemini_request(p_slot_key text, p_local_date date) returns boolean`.
- Produces RPC: `transition_draft(p_draft_id bigint, p_decision text, p_decided_at timestamptz) returns text`.

- [ ] **Step 1: Write failing pgTAP tests**

Cover table existence, RLS, unique canonical URL, unique slot key, valid statuses, a hard daily cap of five, duplicate-slot compensation, and first-terminal-state preservation.

```sql
begin;
select plan(12);

select has_table('public', 'articles');
select has_table('public', 'drafts');
select has_function(
  'public',
  'reserve_gemini_request',
  array['text', 'date']
);
select throws_ok(
  $$insert into public.daily_usage(local_date, gemini_requests)
    values ('2026-08-12', 6)$$,
  '23514'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run database tests to verify RED**

After starting Docker Desktop:

```bash
npx supabase start
npx supabase test db
```

Expected: FAIL because the bot schema and functions do not exist.

- [ ] **Step 3: Create the Postgres schema**

Use `bigint generated always as identity`, `timestamptz`, and `date`. Store the explicit outcomes from the design:

```sql
create table public.articles (
  id bigint generated always as identity primary key,
  canonical_url text not null unique,
  title text not null,
  source_name text not null,
  published_at timestamptz,
  excerpt text not null,
  eligible boolean not null,
  created_at timestamptz not null
);

create table public.scheduled_runs (
  slot_key text primary key,
  local_date date not null,
  outcome text not null check (outcome in (
    'running', 'no_candidate', 'draft_sent', 'rss_unavailable',
    'quota_limited', 'gemini_failed', 'telegram_failed', 'internal_failed'
  )),
  gemini_requests smallint not null default 0
    check (gemini_requests between 0 and 1),
  error_summary text,
  created_at timestamptz not null,
  completed_at timestamptz
);

create table public.daily_usage (
  local_date date primary key,
  gemini_requests smallint not null
    check (gemini_requests between 0 and 5)
);

create table public.drafts (
  id bigint generated always as identity primary key,
  article_id bigint not null references public.articles(id),
  body text not null check (length(btrim(body)) > 0),
  telegram_message_id bigint,
  status text not null check (status in (
    'pending', 'approved', 'rejected', 'failed'
  )),
  created_at timestamptz not null,
  decided_at timestamptz
);

create index drafts_status_created_at_idx
  on public.drafts(status, created_at);
```

Enable RLS on all four tables, create no public policies, revoke table access from `anon` and `authenticated`, and grant required access to `service_role`.

- [ ] **Step 4: Implement atomic RPC functions**

`reserve_gemini_request` must perform the insert, capped update, run marker, and compensation inside one Postgres transaction context:

```sql
create or replace function public.reserve_gemini_request(
  p_slot_key text,
  p_local_date date
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  quota_reserved boolean := false;
  run_marked boolean := false;
begin
  insert into daily_usage(local_date, gemini_requests)
  values (p_local_date, 0)
  on conflict (local_date) do nothing;

  update daily_usage
  set gemini_requests = gemini_requests + 1
  where local_date = p_local_date and gemini_requests < 5
  returning true into quota_reserved;
  if not coalesce(quota_reserved, false) then return false; end if;

  update scheduled_runs
  set gemini_requests = 1
  where slot_key = p_slot_key
    and local_date = p_local_date
    and gemini_requests = 0
  returning true into run_marked;
  if coalesce(run_marked, false) then return true; end if;

  update daily_usage
  set gemini_requests = gemini_requests - 1
  where local_date = p_local_date and gemini_requests > 0;
  return false;
end;
$$;
```

Revoke both RPCs from `public`, `anon`, and `authenticated`; grant execution only to `service_role`.

Implement the transition RPC with validation and first-terminal-state semantics:

```sql
create or replace function public.transition_draft(
  p_draft_id bigint,
  p_decision text,
  p_decided_at timestamptz
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  final_status text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_draft_decision';
  end if;

  update drafts
  set status = p_decision, decided_at = p_decided_at
  where id = p_draft_id and status = 'pending'
  returning status into final_status;

  if final_status is not null then return final_status; end if;
  select status into final_status from drafts where id = p_draft_id;
  return final_status;
end;
$$;
```

- [ ] **Step 5: Verify database behavior**

Run:

```bash
npx supabase db reset
npx supabase test db
npx supabase db lint --level warning
```

Expected: all pgTAP tests PASS and the database linter reports no actionable security warning for the bot objects.

- [ ] **Step 6: Commit the schema**

```bash
git add supabase/migrations supabase/tests/database
git commit -m "feat: add supabase bot schema"
```

---

### Task 3: Supabase repository adapter

**Files:**
- Create: `supabase/functions/_shared/database.types.ts` via local type generation
- Create: `supabase/functions/_shared/domain-types.ts`
- Create: `supabase/functions/_shared/database-client.ts`
- Create: `supabase/functions/_shared/repository.ts`
- Create: `scripts/run-supabase-integration-tests.mjs`
- Create: `vitest.supabase.config.ts`
- Test: `test/supabase/repository.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `createAdminClient(readEnv): SupabaseClient<Database>`.
- Produces: `BotRepository` and `SupabaseBotRepository`.
- `BotRepository` exposes `beginRun`, `getSeenUrls`, `recordArticle`, `reserveGeminiRequest`, `createDraft`, `setDraftTelegramMessage`, `getDraftForCallback`, `transitionDraft`, `markDraftFailed`, and `completeRun`.

Use this exact port so pipeline and webhook tests do not depend on Supabase client internals:

```ts
export interface Article {
  title: string;
  excerpt: string;
  sourceName: string;
  canonicalUrl: string;
  publishedAt: Date;
  sourcePriority: number;
  topicScore: number;
}

export type DraftStatus = "pending" | "approved" | "rejected" | "failed";
export type DraftDecision = Extract<DraftStatus, "approved" | "rejected">;
export type TerminalRunOutcome =
  | "no_candidate"
  | "draft_sent"
  | "rss_unavailable"
  | "quota_limited"
  | "gemini_failed"
  | "telegram_failed"
  | "internal_failed";

export interface StoredDraft {
  body: string;
  canonicalUrl: string;
  status: DraftStatus;
  telegramMessageId: number | null;
}

export interface BotRepository {
  beginRun(slotKey: string, localDate: string, now: Date): Promise<boolean>;
  getSeenUrls(canonicalUrls: readonly string[]): Promise<Set<string>>;
  recordArticle(article: Article, eligible: boolean, now: Date): Promise<number | null>;
  reserveGeminiRequest(slotKey: string, localDate: string): Promise<boolean>;
  createDraft(articleId: number, body: string, now: Date): Promise<number>;
  setDraftTelegramMessage(draftId: number, messageId: number): Promise<boolean>;
  getDraftForCallback(draftId: number): Promise<StoredDraft | null>;
  transitionDraft(draftId: number, decision: DraftDecision, now: Date): Promise<DraftStatus | null>;
  markDraftFailed(draftId: number): Promise<void>;
  completeRun(
    slotKey: string,
    outcome: TerminalRunOutcome,
    errorSummary: string | null,
    now: Date,
  ): Promise<boolean>;
}
```

- [ ] **Step 1: Generate database types**

Run after `npx supabase db reset`:

```bash
npx supabase gen types typescript --local
```

Save the generated output as `supabase/functions/_shared/database.types.ts` and do not hand-edit it.

- [ ] **Step 2: Write failing repository integration tests**

The test creates a real local admin client and verifies the repository against local Postgres:

```ts
it("rejects the sixth reservation and duplicate slot", async () => {
  for (let index = 0; index < 5; index += 1) {
    const slot = `2026-08-12T0${index}:07Z`;
    expect(await repository.beginRun(slot, "2026-08-12", NOW)).toBe(true);
    expect(await repository.reserveGeminiRequest(slot, "2026-08-12")).toBe(true);
  }

  expect(await repository.beginRun("2026-08-12T05:07Z", "2026-08-12", NOW)).toBe(true);
  expect(await repository.reserveGeminiRequest("2026-08-12T05:07Z", "2026-08-12")).toBe(false);
});
```

Also verify chunked URL lookup, unique article insertion, Telegram message storage, and idempotent transitions.

- [ ] **Step 3: Add a secret-safe integration test runner**

The runner executes `npx supabase status -o env`, parses `API_URL` and `SERVICE_ROLE_KEY` in memory, spawns Vitest with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and never prints the status output.

```js
const status = execFileSync("npx", ["supabase", "status", "-o", "env"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const values = parseEnv(status);
const result = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.supabase.config.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      SUPABASE_URL: values.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: values.SERVICE_ROLE_KEY,
    },
  },
);
process.exit(result.status ?? 1);
```

Set `"test:integration": "node scripts/run-supabase-integration-tests.mjs"`.

- [ ] **Step 4: Run the integration test to verify RED**

Run:

```bash
npm run test:integration
```

Expected: FAIL because `SupabaseBotRepository` is missing.

- [ ] **Step 5: Implement the admin client and repository**

Read the new secret-key map first and use the legacy local key only as a local fallback:

```ts
export function createAdminClient(readEnv: RuntimeEnvReader): SupabaseClient<Database> {
  const url = readRequiredEnv("SUPABASE_URL", readEnv);
  const keyMap = readEnv("SUPABASE_SECRET_KEYS");
  const key = keyMap
    ? parseDefaultSecretKey(keyMap)
    : readRequiredEnv("SUPABASE_SERVICE_ROLE_KEY", readEnv);
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

`parseDefaultSecretKey` must parse a JSON object and require a non-empty `default` string; malformed or missing maps throw `invalid_supabase_secret_keys` without including the map. Map Postgres duplicate code `23505` to `false` or `null` only on operations where duplicates are the expected idempotency mechanism. Every other database error throws ``repository_error:${operation}`` without including SQL, values, or provider messages.

- [ ] **Step 6: Verify repository and database contracts**

Run:

```bash
npm run typecheck
npm run test:integration
npx supabase test db
```

Expected: PASS with all reads and mutations occurring against local Postgres.

- [ ] **Step 7: Commit the repository adapter**

```bash
git add package.json scripts vitest.supabase.config.ts supabase/functions/_shared test/supabase
git commit -m "feat: add supabase repository"
```

---

### Task 4: Port RSS, ranking, and Gemini domain modules

**Files:**
- Modify: `supabase/functions/_shared/domain-types.ts`
- Create: `supabase/functions/_shared/limits.ts`
- Create: `supabase/functions/_shared/feed-config.ts`
- Create: `supabase/functions/_shared/rss.ts`
- Create: `supabase/functions/_shared/ranking.ts`
- Create: `supabase/functions/_shared/gemini.ts`
- Test: `test/supabase/feed-config.test.ts`
- Test: `test/supabase/rss.test.ts`
- Test: `test/supabase/ranking.test.ts`
- Test: `test/supabase/gemini.test.ts`

**Interfaces:**
- Extends the Task 3 domain types with `FeedDefinition`, `GeminiConfig`, and `TelegramDraft`.
- Produces `VERIFIED_FEEDS`, `fetchFeedEntries`, `selectBestCandidate`, and `generateDraft` with the existing signatures.

- [ ] **Step 1: Write characterization tests against the Supabase paths**

Copy the behavior assertions, not the Cloudflare runtime setup, from the existing RSS, ranking, and Gemini tests. Add an exact feed assertion:

```ts
expect(VERIFIED_FEEDS).toEqual([
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
```

- [ ] **Step 2: Run focused tests to verify RED**

```bash
npm test -- test/supabase/feed-config.test.ts test/supabase/rss.test.ts test/supabase/ranking.test.ts test/supabase/gemini.test.ts
```

Expected: FAIL because the Supabase domain modules do not exist.

- [ ] **Step 3: Port the existing pure logic**

Preserve the current behavior:

- HTTPS-only canonical URLs with tracking parameters removed.
- Parallel feed fetch using `Promise.allSettled` and an 8-second timeout.
- Highest-priority duplicate wins.
- Topic score must be positive.
- Candidate age must be at most 72 hours with at most five minutes future skew.
- Gemini receives only source name, title, excerpt, and canonical URL.
- Gemini output is truncated to 3,000 characters.

Change only imports and the feed configuration mechanism. Do not read RSS feeds from a secret; use `VERIFIED_FEEDS` as versioned configuration.

- [ ] **Step 4: Verify the port**

```bash
npm run typecheck
npm test -- test/supabase/feed-config.test.ts test/supabase/rss.test.ts test/supabase/ranking.test.ts test/supabase/gemini.test.ts
```

Expected: PASS with no external HTTP call.

- [ ] **Step 5: Commit the domain port**

```bash
git add supabase/functions/_shared test/supabase
git commit -m "feat: port content pipeline modules to supabase"
```

---

### Task 5: Direct Telegram approval webhook

**Files:**
- Modify: `supabase/functions/_shared/telegram.ts`
- Create: `supabase/functions/telegram-webhook/handler.ts`
- Create: `supabase/functions/telegram-webhook/index.ts`
- Test: `test/supabase/telegram-webhook.test.ts`

**Interfaces:**
- Extends `TelegramClient` with `sendDraft`, `answerCallback`, and `editDraftState` using direct Bot API requests.
- Produces `createTelegramWebhookHandler({ readEnv, fetcher, repository })`.

- [ ] **Step 1: Write failing direct-client and webhook tests**

Prove that:

- The direct client sends `sendMessage`, `answerCallbackQuery`, and `editMessageText` to Telegram without a relay envelope.
- Invalid webhook secret returns 401 before database access.
- Foreign chat and mismatched message ID cannot transition a draft.
- ``a:${draftId}`` and ``r:${draftId}`` transition only pending drafts.
- Repeated callbacks keep the first terminal state.
- Telegram acknowledgement or edit failures return 502 but do not revert the durable decision.

```ts
expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
  "https://api.telegram.org/bottest-token/answerCallbackQuery",
  "https://api.telegram.org/bottest-token/editMessageText",
]);
expect(repository.drafts.get(draftId)?.status).toBe("approved");
```

- [ ] **Step 2: Run focused tests to verify RED**

```bash
npm test -- test/supabase/telegram-direct.test.ts test/supabase/telegram-webhook.test.ts
```

Expected: FAIL because the direct draft/callback methods and webhook handler are missing.

- [ ] **Step 3: Extend the direct Telegram client**

Use these signatures:

```ts
sendDraft(draft: TelegramDraft): Promise<number>;
answerCallback(callbackQueryId: string, text: string): Promise<void>;
editDraftState(
  telegramMessageId: number,
  currentText: string,
  status: Exclude<DraftStatus, "pending">,
): Promise<void>;
```

Preserve the 4,096-character Telegram text limit and compact button payloads ``a:${draft.id}`` and ``r:${draft.id}``.

- [ ] **Step 4: Implement the webhook handler**

The handler accepts only POST, validates `X-Telegram-Bot-Api-Secret-Token`, parses only `callback_query`, validates chat ID and stored message ID, transitions through `BotRepository`, and never stores the raw update.

```ts
export interface TelegramWebhookDependencies {
  readEnv: RuntimeEnvReader;
  fetcher: typeof fetch;
  repository: BotRepository;
}

export function createTelegramWebhookHandler(
  dependencies: TelegramWebhookDependencies,
): (request: Request) => Promise<Response>;
```

- [ ] **Step 5: Verify unit and integration behavior**

```bash
npm run typecheck
npm test -- test/supabase/telegram-direct.test.ts test/supabase/telegram-webhook.test.ts
npm run test:integration
```

Expected: all tests PASS and no test contacts Telegram.

- [ ] **Step 6: Deploy without switching Telegram yet**

```bash
npx supabase functions deploy telegram-webhook --use-api
```

Expected: deployment succeeds. Do not call `setWebhook` in this task.

- [ ] **Step 7: Commit the webhook**

```bash
git add supabase/functions/_shared/telegram.ts supabase/functions/telegram-webhook test/supabase
git commit -m "feat: add supabase telegram webhook"
```

---

### Task 6: Scheduled Supabase content pipeline

**Files:**
- Create: `supabase/functions/_shared/pipeline.ts`
- Create: `supabase/functions/scheduled-pipeline/handler.ts`
- Create: `supabase/functions/scheduled-pipeline/index.ts`
- Test: `test/supabase/pipeline.test.ts`
- Test: `test/supabase/scheduled-handler.test.ts`

**Interfaces:**
- Produces `runScheduledPipeline(dependencies, scheduledAt): Promise<TerminalRunOutcome>`.
- Produces `createScheduledPipelineHandler({ readEnv, fetcher, repository, now })`.

- [ ] **Step 1: Write failing pipeline tests**

Cover these outcomes exactly:

```ts
type TerminalRunOutcome =
  | "no_candidate"
  | "draft_sent"
  | "rss_unavailable"
  | "quota_limited"
  | "gemini_failed"
  | "telegram_failed"
  | "internal_failed";
```

Required assertions:

- No candidate makes zero Gemini and Telegram calls.
- All feeds failed records `rss_unavailable`.
- The sixth reservation records `quota_limited`.
- A successful candidate creates one draft and stores one Telegram message ID.
- A Telegram failure marks the generated draft failed and preserves the one Gemini reservation.
- Repeating the same slot performs no external call.
- Invalid `X-Scheduled-Secret` performs no database or external call.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
npm test -- test/supabase/pipeline.test.ts test/supabase/scheduled-handler.test.ts
```

Expected: FAIL because the pipeline and handler do not exist.

- [ ] **Step 3: Port pipeline orchestration behind dependency ports**

Use an explicit dependency object so every external call remains mockable:

```ts
export interface PipelineDependencies {
  repository: BotRepository;
  fetchFeeds: typeof fetchFeedEntries;
  selectCandidate: typeof selectBestCandidate;
  generate: typeof generateDraft;
  telegram: TelegramClient;
  feeds: readonly FeedDefinition[];
  fetcher: typeof fetch;
}
```

Derive the slot key with minute precision from UTC and derive the local date using `Intl.DateTimeFormat` with `Asia/Ho_Chi_Minh`. Never accept a caller-supplied quota date.

- [ ] **Step 4: Implement the private HTTP handler**

The handler:

- accepts only POST;
- compares `X-Scheduled-Secret` before constructing the repository;
- uses `now()` as the scheduled instant;
- returns generic JSON `JSON.stringify({ status: outcome, slotKey })`;
- logs only event name, slot key, source count, duration, draft ID, and bounded category.

- [ ] **Step 5: Verify the complete local pipeline**

```bash
npm run typecheck
npm test -- test/supabase/pipeline.test.ts test/supabase/scheduled-handler.test.ts
npm run test:integration
npx supabase test db
```

Expected: PASS with mocked external providers and real local Postgres repository tests.

- [ ] **Step 6: Deploy the scheduled function without enabling Cron**

```bash
npx supabase functions deploy scheduled-pipeline --use-api
```

Expected: deployment succeeds. Do not create a Cron job yet.

- [ ] **Step 7: Run one authenticated manual smoke test**

Read `SCHEDULED_FUNCTION_SECRET` silently, call the hosted scheduled function once, and unset it. Tail Supabase function logs from the dashboard without printing bodies.

Expected: one of `no_candidate` or `draft_sent`. For `draft_sent`, Telegram receives one reviewable English draft and Postgres contains one matching run, article, draft, and daily usage reservation.

- [ ] **Step 8: Commit the pipeline**

```bash
git add supabase/functions/_shared/pipeline.ts supabase/functions/scheduled-pipeline test/supabase
git commit -m "feat: add supabase scheduled pipeline"
```

---

### Task 7: Cron configuration and production cutover

**Files:**
- Create: `supabase/ops/configure-cron.sql`
- Create: `supabase/ops/disable-cron.sql`
- Create: `supabase/ops/verify-cron.sql`
- Test: `test/supabase/cron-config.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces one Cron job named `football-news-pipeline` with expression `7 1,4,7,10,13 * * *`.
- Reads Vault entries named `project_url` and `scheduled_function_secret` at execution time; the decrypted values are never embedded in `cron.job.command`.

- [ ] **Step 1: Write a failing static Cron contract test**

```ts
expect(configureSql).toContain("'football-news-pipeline'");
expect(configureSql).toContain("'7 1,4,7,10,13 * * *'");
expect(configureSql).toContain("name = 'project_url'");
expect(configureSql).toContain("name = 'scheduled_function_secret'");
expect(configureSql).not.toMatch(/sb_secret_|bot\d+:/);
```

- [ ] **Step 2: Run the Cron test to verify RED**

```bash
npm test -- test/supabase/cron-config.test.ts
```

Expected: FAIL because the operations SQL does not exist.

- [ ] **Step 3: Add repeatable Cron operations SQL**

`configure-cron.sql` first unschedules an existing job with the same name, then schedules exactly one command:

```sql
select cron.schedule(
  'football-news-pipeline',
  '7 1,4,7,10,13 * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'project_url'
    ) || '/functions/v1/scheduled-pipeline',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'X-Scheduled-Secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'scheduled_function_secret'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
```

`disable-cron.sql` unschedules only `football-news-pipeline`. `verify-cron.sql` selects the job definition and the latest ten `cron.job_run_details` rows without selecting Vault values.

- [ ] **Step 4: Document the exact cutover runbook**

README must include:

1. Start Docker and run the local full verification gate.
2. Run `npx supabase db push` and deploy both production functions.
3. Inspect remote D1 table counts read-only; export only pending or approved drafts if present.
4. Create `project_url` and `scheduled_function_secret` through Supabase Vault UI.
5. Run the manual scheduled-pipeline smoke test.
6. Read the project ref into `SUPABASE_PROJECT_REF` and register Telegram webhook directly to `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/telegram-webhook`, including `secret_token` and `allowed_updates=["callback_query"]`.
7. Verify `getWebhookInfo` shows the Supabase URL, zero pending errors, and no recent delivery error.
8. Approve one controlled draft and verify Postgres status.
9. Disable the Cloudflare Cron trigger through Cloudflare Dashboard.
10. Run `configure-cron.sql`, then verify exactly one active Supabase job.

Bot token and webhook secret commands must read values silently into shell variables and unset them immediately.

- [ ] **Step 5: Verify documentation and Cron configuration**

```bash
npm test -- test/supabase/cron-config.test.ts
git diff --check
```

Expected: PASS; no secret-shaped literal appears in `supabase/`, `README.md`, or Git diff.

- [ ] **Step 6: Commit the operations runbook**

```bash
git add supabase/ops test/supabase/cron-config.test.ts README.md
git commit -m "feat: add supabase cron operations"
```

- [ ] **Step 7: Execute cutover with rollback checkpoints**

Execute the README steps in order. Stop and restore the previous Telegram webhook if the Supabase webhook fails. Do not enable both Cron providers simultaneously. Do not remove Apps Script or relay secrets until one direct Supabase draft and one callback have succeeded.

Expected: Telegram `getWebhookInfo` points to Supabase, Cloudflare Cron is disabled, exactly one Supabase production Cron job is active, and a complete draft/approval is durable in Postgres.

---

### Task 8: Retire Cloudflare and Google Apps Script relay code

**Files:**
- Delete: `relay/Code.gs`
- Delete: `src/diagnostic.ts`
- Delete: `src/index.ts`
- Delete: `src/pipeline.ts`
- Delete: `src/repository.ts`
- Delete: `src/telegram.ts`
- Delete: `src/types.ts`
- Delete: `src/webhook.ts`
- Delete: `src/config.ts`
- Delete: `src/gemini.ts`
- Delete: `src/limits.ts`
- Delete: `src/ranking.ts`
- Delete: `src/rss.ts`
- Delete: `migrations/0001_initial.sql`
- Delete: `wrangler.jsonc`
- Delete: `.dev.vars.example`
- Delete: `vitest.config.ts`
- Delete: `tsconfig.supabase.json`
- Delete: `test/config.test.ts`
- Delete: `test/gemini.test.ts`
- Delete: `test/pipeline.test.ts`
- Delete: `test/ranking.test.ts`
- Delete: `test/relay.test.ts`
- Delete: `test/repository.test.ts`
- Delete: `test/rss.test.ts`
- Delete: `test/schema.test.ts`
- Delete: `test/telegram.test.ts`
- Delete: `test/webhook.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `.gitignore`
- Modify: `README.md`
- Test: all remaining `test/supabase/*.test.ts`

**Interfaces:**
- Leaves Supabase as the only active runtime in the repository.
- Preserves earlier Cloudflare design and plan documents as historical records.
- Does not delete remote D1 data.

- [ ] **Step 1: Add a failing repository-boundary test**

Add a configuration test that asserts no active source, package script, dependency, or README instruction references Wrangler, D1, `TELEGRAM_RELAY_URL`, `TELEGRAM_RELAY_SECRET`, `script.google`, or `relay/Code.gs`.

```ts
for (const forbidden of [
  "wrangler",
  "D1Database",
  "TELEGRAM_RELAY_URL",
  "TELEGRAM_RELAY_SECRET",
  "script.google",
]) {
  expect(activeRuntimeText).not.toContain(forbidden);
}
```

- [ ] **Step 2: Run the boundary test to verify RED**

```bash
npm test -- test/supabase/runtime-boundary.test.ts
```

Expected: FAIL because the old runtime and relay still exist.

- [ ] **Step 3: Remove only retired runtime files and dependencies**

Remove `wrangler`, `@cloudflare/workers-types`, and `@cloudflare/vitest-pool-workers`. Preserve `typescript`, `vitest`, `fast-xml-parser`, `supabase`, and `@supabase/supabase-js`. Replace scripts with:

```json
{
  "test": "vitest run",
  "typecheck": "tsc --noEmit",
  "lint": "tsc --noEmit",
  "test:db": "supabase test db",
  "test:integration": "node scripts/run-supabase-integration-tests.mjs",
  "supabase:start": "supabase start",
  "supabase:stop": "supabase stop"
}
```

Update `tsconfig.json` to include `supabase/functions/**/*.ts`, exclude each Deno `index.ts`, and remove Cloudflare ambient types.

- [ ] **Step 4: Replace README with the Supabase operating guide**

The final README must explain setup, local tests, secrets, deployment, manual pipeline invocation, Telegram webhook registration, Cron operations, logs, rollback, Free-plan pause risk, and the explicit boundary that approval does not yet publish to X.

Include operator cleanup after successful observation:

- Delete the Google Apps Script web-app deployment and its Script Properties.
- Delete Cloudflare relay-only secrets and diagnostic secret.
- Keep the Cloudflare Worker disabled and D1 retained until the operator separately authorizes deletion.

- [ ] **Step 5: Run the complete final verification gate**

With Docker Desktop running:

```bash
npm run typecheck
npm test
npx supabase db reset
npx supabase test db
npm run test:integration
npx supabase db lint --level warning
npx supabase functions serve telegram-webhook
npx supabase functions serve scheduled-pipeline
git diff --check
```

Expected: all tests and typechecks PASS; each Edge Function bundles and reaches local Ready state; database lint has no actionable warning; Git diff has no whitespace error or secret-shaped value. Stop serve processes after Ready is confirmed.

- [ ] **Step 6: Request final code review**

Invoke `superpowers:requesting-code-review`. Resolve every Critical or Important finding with a focused RED/GREEN regression test and rerun the complete verification gate.

- [ ] **Step 7: Commit runtime retirement**

```bash
git add -A
git commit -m "refactor: retire cloudflare telegram relay"
```

- [ ] **Step 8: Push only after the final verification commit is clean**

```bash
git status --short
git push origin feat/cloud-football-news-bot
```

Expected: clean worktree and the remote branch contains the Supabase migration commits. Do not merge to `main` without a separate branch-finishing decision.
