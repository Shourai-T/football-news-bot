# Football News Bot Cloud MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build and deploy a TypeScript Cloudflare Worker which creates no more than five English football-news Telegram drafts per Vietnam day from configured RSS feeds and lets the private configured chat approve or reject a draft.

**Architecture:** The Worker has a scheduled entry for the RSS-to-Gemini path and an HTTPS Telegram webhook entry for inline-button callbacks. Cloudflare D1 persists URL deduplication, run-slot idempotency, daily quota, and draft state. All API calls sit behind small REST-client modules so automated tests use mocked fetch and local D1 only.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Wrangler, Vitest, fast-xml-parser, Gemini REST API, Telegram Bot API.

## Global Constraints

- No personal computer needs to remain online; no Python runtime.
- Cron is 7 1,4,7,10,13 * * * UTC, equal to 08:07, 11:07, 14:07, 17:07 and 20:07 in Asia/Ho_Chi_Minh.
- Maximum five Gemini generation requests per Asia/Ho_Chi_Minh calendar day.
- Ingest configured public RSS or Atom endpoints only. Never scrape article pages.
- Never commit secrets. No X credential, client, or publishing code.
- Verify the Telegram webhook secret header and configured chat ID before a callback changes data.
- Every external request has an eight-second timeout. Tests never call external services.

---

## File Map

| File | Responsibility |
| --- | --- |
| package.json, tsconfig.json, vitest.config.ts | Dependencies, scripts, test runtime |
| wrangler.jsonc, .gitignore, .dev.vars.example | Binding, Cron, safe configuration |
| migrations/0001_initial.sql | D1 tables, constraints, and indexes |
| src/types.ts, src/config.ts | Domain types and validated feed configuration |
| src/rss.ts, src/ranking.ts | RSS normalization, canonical URLs and pure selection |
| src/repository.ts | Parameterized D1 operations and state transitions |
| src/gemini.ts, src/telegram.ts | Bounded REST clients |
| src/pipeline.ts, src/webhook.ts, src/index.ts | Orchestration and Worker entry points |
| test directory | Unit and integration-style fixtures/tests |
| README.md | Setup, deployment, webhook and operations guide |

## Task 1: Create Worker scaffold, schema, and local test harness

**Files:**
- Create: package.json, tsconfig.json, vitest.config.ts, wrangler.jsonc
- Create: .gitignore, .dev.vars.example, migrations/0001_initial.sql
- Create: src/types.ts, test/schema.test.ts

**Interfaces:**
- Produces Env, FeedDefinition, Article, DraftStatus, and RunOutcome.
- Env has D1 binding DB, five secrets TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, GEMINI_API_KEY, GEMINI_MODEL, and non-secret RSS_FEEDS_JSON.

- [ ] **Step 1: Write the failing domain test**

~~~ts
import { describe, expect, it } from "vitest";
import { DraftStatus } from "../src/types";

describe("draft lifecycle", () => {
  it("has only the expected persistent states", () => {
    const values: DraftStatus[] = ["pending", "approved", "rejected", "failed"];
    expect(values).toHaveLength(4);
  });
});
~~~

- [ ] **Step 2: Run the failing test**

Run: npm test -- schema.test.ts

Expected: FAIL because the TypeScript project and src/types.ts do not exist.

- [ ] **Step 3: Implement the minimum types and migration**

~~~ts
export type DraftStatus = "pending" | "approved" | "rejected" | "failed";
export type RunOutcome = "running" | "no_candidate" | "draft_sent" | "failed";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  RSS_FEEDS_JSON: string;
}
~~~

~~~sql
CREATE TABLE articles (
  id INTEGER PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  published_at TEXT,
  excerpt TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE TABLE scheduled_runs (
  slot_key TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('running','no_candidate','draft_sent','failed')),
  gemini_requests INTEGER NOT NULL DEFAULT 0 CHECK (gemini_requests BETWEEN 0 AND 1),
  error_summary TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE daily_usage (
  local_date TEXT PRIMARY KEY,
  gemini_requests INTEGER NOT NULL CHECK (gemini_requests BETWEEN 0 AND 5)
);
CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  body TEXT NOT NULL,
  telegram_message_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','failed')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX drafts_status_idx ON drafts(status, created_at);
~~~

Configure the D1 binding DB and exactly five UTC Cron slots. Ignore .dev.vars. The example file lists keys only.

- [ ] **Step 4: Verify scaffold**

Run: npm run typecheck && npm test -- schema.test.ts && npx wrangler d1 migrations apply DB --local

Expected: PASS; local D1 contains all four tables.

- [ ] **Step 5: Commit**

~~~bash
git add package.json package-lock.json tsconfig.json vitest.config.ts wrangler.jsonc .gitignore .dev.vars.example migrations/0001_initial.sql src/types.ts test/schema.test.ts
git commit -m "feat: scaffold cloud worker"
~~~

## Task 2: Fetch, normalize, filter and rank RSS entries

**Files:**
- Create: src/config.ts, src/rss.ts, src/ranking.ts
- Create: test/rss.test.ts, test/ranking.test.ts

**Interfaces:**
- Produces parseFeeds(raw), canonicalizeUrl(rawUrl), fetchFeedEntries(feeds, fetcher, now), and selectBestCandidate(entries, seenUrls, now).
- Consumes Article and FeedDefinition from src/types.ts.

- [ ] **Step 1: Write failing parser/ranker tests**

~~~ts
it("removes a tracking parameter but preserves an article parameter", () => {
  expect(canonicalizeUrl("https://example.test/a?utm_source=rss&id=9"))
    .toBe("https://example.test/a?id=9");
});

it("selects a fresh eligible higher-priority transfer article", () => {
  expect(selectBestCandidate(entries, new Set(), NOW)?.canonicalUrl)
    .toBe("https://bbc.test/transfer");
});
~~~

- [ ] **Step 2: Confirm tests fail**

Run: npm test -- rss.test.ts ranking.test.ts

Expected: FAIL because parser and ranker are undefined.

- [ ] **Step 3: Implement bounded feed handling**

~~~ts
export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "fbclid" || key === "gclid") {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  return url.toString();
}

export function selectBestCandidate(entries: Article[], seenUrls: ReadonlySet<string>, now: Date): Article | null {
  return entries
    .filter((entry) => !seenUrls.has(entry.canonicalUrl))
    .filter((entry) => entry.topicScore > 0 && now.getTime() - entry.publishedAt.getTime() <= 72 * 60 * 60 * 1000)
    .sort((a, b) => b.sourcePriority - a.sourcePriority || b.topicScore - a.topicScore || b.publishedAt.getTime() - a.publishedAt.getTime())[0] ?? null;
}
~~~

Use fast-xml-parser. Accept HTTPS entry links only. Each RSS request uses AbortSignal.timeout(8000); Promise.allSettled isolates failed feeds. Score title/excerpt matches for Messi, Ronaldo, transfers, breaking football news, major clubs, star players, Champions League and Premier League. RSS_FEEDS_JSON contains named source URLs, so verified official feeds can be supplied without code changes.

- [ ] **Step 4: Verify behavior**

Run: npm test -- rss.test.ts ranking.test.ts && npm run lint

Expected: PASS for malformed XML, failed feed, duplicate canonical URL, stale/off-topic entry, and ranking fixtures.

- [ ] **Step 5: Commit**

~~~bash
git add src/config.ts src/rss.ts src/ranking.ts test/rss.test.ts test/ranking.test.ts
git commit -m "feat: add rss candidate selection"
~~~

## Task 3: Add durable repository, Gemini, and Telegram client contracts

**Files:**
- Create: src/repository.ts, src/gemini.ts, src/telegram.ts
- Create: test/repository.test.ts, test/gemini.test.ts, test/telegram.test.ts
- Modify: src/types.ts

**Interfaces:**
- Repository exports beginRun, getSeenUrls, recordArticle, reserveGeminiRequest, createDraft, setDraftTelegramMessage, transitionDraft, and completeRun.
- generateDraft(article, config, fetcher) returns a non-empty English string.
- TelegramClient exposes sendDraft, answerCallback, and editDraftState.

- [ ] **Step 1: Write failing state and client tests**

~~~ts
it("rejects the sixth Gemini reservation in one Vietnam day", async () => {
  for (let index = 0; index < 5; index += 1) {
    const key = "slot-" + index;
    await repository.beginRun(key, "2026-08-10");
    expect(await repository.reserveGeminiRequest(key, "2026-08-10")).toBe(true);
  }
  await repository.beginRun("slot-6", "2026-08-10");
  expect(await repository.reserveGeminiRequest("slot-6", "2026-08-10")).toBe(false);
});

it("uses a compact approval callback payload", async () => {
  await telegram.sendDraft(draft);
  expect(await fetchMock.jsonBody()).toMatchObject({
    reply_markup: { inline_keyboard: [[{ callback_data: "a:42" }, { callback_data: "r:42" }]] },
  });
});
~~~

- [ ] **Step 2: Confirm tests fail**

Run: npm test -- repository.test.ts gemini.test.ts telegram.test.ts

Expected: FAIL because the repository and clients do not exist.

- [ ] **Step 3: Implement parameterized persistence and bounded clients**

~~~ts
const update = await db.prepare(
  "UPDATE daily_usage SET gemini_requests = gemini_requests + 1 WHERE local_date = ? AND gemini_requests < 5",
).bind(localDate).run();
if (update.meta.changes !== 1) return false;
const mark = await db.prepare(
  "UPDATE scheduled_runs SET gemini_requests = 1 WHERE slot_key = ? AND gemini_requests = 0",
).bind(slotKey).run();
return mark.meta.changes === 1;
~~~

Create daily_usage first with INSERT OR IGNORE. If marking the run fails, compensate the count in the same batch/transaction design. All SQL uses bindings. Store a candidate URL before Gemini to prevent a retry drafting it twice. A transition changes only pending drafts and returns the existing terminal status on repeated clicks.

Gemini prompt uses only source name, title, excerpt, and canonical URL; it instructs factual English output with no invented claims. Validate a non-empty returned candidate. Telegram uses sendMessage, answerCallbackQuery, and editMessageText; the buttons are attached only after D1 draft creation. Apply eight-second timeout/error mapping; never log request URLs, secrets, request body, or provider body.

- [ ] **Step 4: Verify repository and client contracts**

Run: npm test -- repository.test.ts gemini.test.ts telegram.test.ts && npm run typecheck

Expected: PASS for cap, duplicate slot/URL, idempotent terminal state, empty Gemini response, API errors, keyboard payload and Telegram acknowledgement.

- [ ] **Step 5: Commit**

~~~bash
git add src/types.ts src/repository.ts src/gemini.ts src/telegram.ts test/repository.test.ts test/gemini.test.ts test/telegram.test.ts
git commit -m "feat: add draft persistence and api clients"
~~~

## Task 4: Compose Worker paths, integration tests, and operations guide

**Files:**
- Create: src/pipeline.ts, src/webhook.ts, src/index.ts
- Create: test/pipeline.test.ts, test/webhook.test.ts, test/config.test.ts
- Create: README.md
- Modify: .dev.vars.example, wrangler.jsonc

**Interfaces:**
- Produces runScheduledPipeline(env, scheduledTime, fetcher) and handleTelegramWebhook(request, env, fetcher).
- Worker default exports scheduled and fetch only.

- [ ] **Step 1: Write failing end-to-end boundary tests**

~~~ts
it("records no_candidate without calling Gemini when all entries are seen", async () => {
  await runScheduledPipeline(envWithSeenArticle, SCHEDULED_TIME, fetchMock);
  expect(fetchMock.callsTo("generativelanguage.googleapis.com")).toBe(0);
  expect(await repository.runOutcome(SLOT_KEY)).toBe("no_candidate");
});

it("rejects a callback with an invalid Telegram secret before state changes", async () => {
  const response = await handleTelegramWebhook(requestWithSecret("wrong"), env, fetchMock);
  expect(response.status).toBe(401);
  expect(await repository.draftStatus(42)).toBe("pending");
});
~~~

- [ ] **Step 2: Confirm tests fail**

Run: npm test -- pipeline.test.ts webhook.test.ts config.test.ts

Expected: FAIL because orchestrators and feed validation are undefined.

- [ ] **Step 3: Implement protected Worker paths**

~~~ts
export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledPipeline(env, Date.now(), fetch));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    return handleTelegramWebhook(request, env, fetch);
  },
};
~~~

Derive slot key and daily quota key from scheduled time in Asia/Ho_Chi_Minh. Begin the run before RSS fetch and stop on an existing slot. Log a short error category only. Webhook handling verifies X-Telegram-Bot-Api-Secret-Token, accepts callback_query only, validates callback format a:id or r:id, verifies callback chat ID, transitions D1 atomically, then answers and edits the message.

README documents npm install; Wrangler login; D1 creation; copying the database ID into wrangler.jsonc; remote migration; setting five secrets and RSS_FEEDS_JSON; deploy; setWebhook registration; wrangler tail; and webhook removal. It uses placeholders only and explicitly prohibits scraping club websites.

- [ ] **Step 4: Run final local verification**

Run: npm test && npm run typecheck && npx wrangler dev --test-scheduled --local && npx wrangler deploy --dry-run

Expected: PASS. Tests prove no candidate spends no Gemini request, duplicates do not redraft, daily request six is blocked, foreign callbacks cannot change a draft, and repeated approval is idempotent. Do not create remote resources, store real secrets, or register a webhook without explicit user deployment approval.

- [ ] **Step 5: Commit**

~~~bash
git add src/pipeline.ts src/webhook.ts src/index.ts README.md .dev.vars.example wrangler.jsonc test/pipeline.test.ts test/webhook.test.ts test/config.test.ts
git commit -m "feat: add cloud approval workflow"
~~~

## Plan Self-Review

- Spec coverage: Tasks 1-4 cover TypeScript Worker, D1, five Cron slots, RSS-only ingestion, factual English Gemini draft, Telegram approval, quota, deduplication, errors, tests, and safe deployment documentation.
- Type consistency: Task 1 introduces Env and domain types; later tasks consume exactly those names. Only Cron uses UTC; daily quota is Asia/Ho_Chi_Minh.
- Scope: X publishing is absent; RSS source URLs remain deployment configuration because official club feeds are not universal and must be verified rather than guessed.
