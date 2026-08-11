# Telegram Relay Phase Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify whether the deployed Cloudflare Worker fails on the initial Apps Script POST or the redirected Google Content Service GET without exposing sensitive data.

**Architecture:** `TelegramRequestError` carries an optional fixed phase, and each fetch boundary classifies its own failures. The secret-protected health handler returns and logs only that fixed phase; all existing error categories and redaction rules remain intact.

**Tech Stack:** TypeScript 7, Cloudflare Workers, Vitest 4, Wrangler 4.

## Global Constraints

- Allowed diagnostic phases are exactly `relay_post` and `relay_redirect`.
- Do not log or return relay URLs, redirect URLs, relay secrets, Telegram bot tokens, chat IDs, request bodies, response bodies, or original exception text.
- Keep `POST /internal/telegram-health` protected by `X-Diagnostic-Secret`.
- Parsing and arbitrary non-transport errors do not receive a fabricated phase.
- Do not change Cloudflare secrets, Apps Script properties, D1, cron, Gemini, RSS, Telegram callback behavior, or X-related behavior.
- Do not delete `TELEGRAM_BOT_TOKEN` while the relay remains unhealthy.
- This work diagnoses the failing boundary; it does not claim to fix Telegram delivery.

---

### Task 1: Classify and expose the fixed fetch phase

**Files:**
- Modify: `test/telegram.test.ts`
- Modify: `test/webhook.test.ts`
- Modify: `src/telegram.ts`
- Modify: `src/diagnostic.ts`

**Interfaces:**
- Produces: `TelegramRequestPhase = "relay_post" | "relay_redirect"`.
- Produces: `TelegramRequestError(message, transport, phase?)` with public readonly `transport` and optional readonly `phase`.
- Consumes: existing `TelegramClient.checkHealth()` and `handleTelegramHealth(request, env, fetcher)` interfaces; their signatures do not change.

- [ ] **Step 1: Add failing Telegram boundary tests**

In `test/telegram.test.ts`, extend the existing redirected rejection and timeout expectations with `phase: "relay_redirect"`. Add these initial-boundary cases:

```ts
it("classifies and redacts an initial relay POST rejection", async () => {
  const privateDetail = "private initial fetch detail";
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateDetail));

  await expect(client(fetcher).checkHealth()).rejects.toMatchObject({
    message: "telegram_network_error",
    transport: "fetch_rejected",
    phase: "relay_post",
  });
  await expect(client(fetcher).checkHealth()).rejects.not.toThrow(privateDetail);
});

it("classifies an initial relay POST timeout", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
    new DOMException("request timed out", "TimeoutError"),
  );

  await expect(client(fetcher).checkHealth()).rejects.toMatchObject({
    message: "telegram_timeout",
    transport: "timeout",
    phase: "relay_post",
  });
});
```

The redirected expectations become:

```ts
await expect(client(createFetcher()).checkHealth()).rejects.toMatchObject({
  message: "telegram_network_error",
  transport: "fetch_rejected",
  phase: "relay_redirect",
});
```

```ts
await expect(client(fetcher).checkHealth()).rejects.toMatchObject({
  message: "telegram_timeout",
  transport: "timeout",
  phase: "relay_redirect",
});
```

- [ ] **Step 2: Run the Telegram phase tests and verify RED**

Run:

```bash
npm test -- telegram.test.ts -t "initial relay POST|redirected GET|valid relay redirect"
```

Expected: FAIL because `TelegramRequestError` does not expose `phase` and the current shared catch cannot distinguish the two fetch boundaries.

- [ ] **Step 3: Add failing protected health response tests**

In `test/webhook.test.ts`, update the initial fetch rejection expectation to the following exact fixed response and log:

```ts
expect(JSON.parse(responseBody)).toEqual({
  status: "unavailable",
  category: "telegram_network_error",
  transport: "fetch_rejected",
  phase: "relay_post",
});
expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
  event: "telegram_health_failed",
  category: "telegram_network_error",
  phase: "relay_post",
}));
```

Update the initial aborted-fetch test analogously with category
`telegram_timeout`, transport `timeout`, and phase `relay_post`.

Keep the response-body timeout expectation exactly phase-free:

```ts
expect(await response.json()).toEqual({
  status: "unavailable",
  category: "telegram_timeout",
  transport: "timeout",
});
expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
  event: "telegram_health_failed",
  category: "telegram_timeout",
}));
```

Keep the arbitrary-error expectation exactly phase-free:

```ts
expect(JSON.parse(responseBody)).toEqual({
  status: "unavailable",
  category: "diagnostic_error",
  transport: "fetch_rejected",
});
```

- [ ] **Step 4: Run the protected health tests and verify RED**

Run:

```bash
npm test -- webhook.test.ts -t "Telegram health"
```

Expected: FAIL because the protected response and fixed console event do not include `phase` for transport errors.

- [ ] **Step 5: Implement phase-specific transport errors**

In `src/telegram.ts`, add the type and optional constructor field:

```ts
export type TelegramRequestPhase = "relay_post" | "relay_redirect";

export class TelegramRequestError extends Error {
  constructor(
    message: "telegram_timeout" | "telegram_network_error",
    readonly transport: "timeout" | "fetch_rejected",
    readonly phase?: TelegramRequestPhase,
  ) {
    super(message);
  }
}
```

Create a single redacted mapper:

```ts
function toTelegramRequestError(
  error: unknown,
  phase: TelegramRequestPhase,
): TelegramRequestError {
  const timeout = isTimeout(error);
  return new TelegramRequestError(
    timeout ? "telegram_timeout" : "telegram_network_error",
    timeout ? "timeout" : "fetch_rejected",
    phase,
  );
}
```

Restrict the first `try/catch` in `#request` to the initial POST and map it with
`relay_post`:

```ts
const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
try {
  response = await this.fetcher(this.config.relayUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: this.config.relaySecret,
      chatId: this.config.chatId,
      method,
      body,
    }),
    redirect: "manual",
    signal,
  });
} catch (error) {
  throw toTelegramRequestError(error, "relay_post");
}
response = await followAppsScriptRedirect(response, this.fetcher, signal);
```

Wrap only the redirected GET inside `followAppsScriptRedirect`:

```ts
try {
  return await fetcher(location, {
    method: "GET",
    redirect: "error",
    signal,
  });
} catch (error) {
  throw toTelegramRequestError(error, "relay_redirect");
}
```

Do not change the phase-free response-body timeout constructor.

- [ ] **Step 6: Implement fixed phase output in the health handler**

In `src/diagnostic.ts`, build a phase object only for classified transport
errors:

```ts
const phase = error instanceof TelegramRequestError && error.phase !== undefined
  ? { phase: error.phase }
  : {};
console.error(JSON.stringify({ event: "telegram_health_failed", category, ...phase }));
return Response.json(
  { status: "unavailable", category, transport, ...phase },
  { status: 502 },
);
```

The existing secret check, success response, category mapping, and fallback
transport remain unchanged.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
npm test -- telegram.test.ts webhook.test.ts
```

Expected: both files pass; transport errors contain the correct fixed phase;
parsing and arbitrary errors remain phase-free.

- [ ] **Step 8: Run the complete local gate**

Run:

```bash
npm run typecheck
npm test
npm run lint
WRANGLER_LOG_PATH=/tmp/football-news-bot-phase-dry-run.log npx wrangler deploy --dry-run
git diff --check
```

Expected: every command exits 0, all test suites pass, and Wrangler creates a
dry-run bundle without deploying.

- [ ] **Step 9: Review and commit**

Review the diff against every Global Constraint. Fix Critical and Important
findings; any behavior fix requires a failing regression test first. Then run
Step 8 again and commit:

```bash
git add src/telegram.ts src/diagnostic.ts test/telegram.test.ts test/webhook.test.ts
git commit -m "fix: identify telegram relay failure phase"
```

### Task 2: Deploy and capture the failing boundary

**Files:**
- No source changes expected.
- Inspect: `wrangler.jsonc` and the reviewed Task 1 commit.

**Interfaces:**
- Consumes: the existing Cloudflare Worker and its secret-protected `POST /internal/telegram-health` route.
- Produces: one live response containing exactly `phase: "relay_post"` or `phase: "relay_redirect"` for the current `fetch_rejected` failure.

- [ ] **Step 1: Push the reviewed branch**

Run:

```bash
git push origin feat/cloud-football-news-bot
```

Expected: origin advances through the phase design, plan, and implementation commits.

- [ ] **Step 2: Deploy the reviewed Worker**

Run:

```bash
WRANGLER_LOG_PATH=/tmp/football-news-bot-phase-deploy.log npx wrangler deploy
```

Expected: Wrangler reports the production Worker URL and a new version ID.

- [ ] **Step 3: Establish a known diagnostic secret without printing it**

Run in one shell process:

```bash
task_diagnostic_secret="$(openssl rand -hex 32)"
printf '%s' "$task_diagnostic_secret" \
  | WRANGLER_LOG_PATH=/tmp/football-news-bot-phase-secret.log \
    npx wrangler secret put DIAGNOSTIC_SECRET
```

Expected: Wrangler confirms the secret upload; no secret value appears in output.

- [ ] **Step 4: Call the protected health endpoint once**

In the same shell process, run:

```bash
curl --silent --show-error --fail-with-body \
  --request POST "https://football-news-bot.football-news-bot.workers.dev/internal/telegram-health" \
  --header "X-Diagnostic-Secret: $task_diagnostic_secret"
unset task_diagnostic_secret
```

Expected: HTTP 502 with the existing redacted category and exactly one fixed
phase. Record whether it is `relay_post` or `relay_redirect`; do not make another
transport change in this task.

- [ ] **Step 5: Stop at the evidence boundary**

If the phase is `relay_post`, the next root-cause task investigates Worker access
to Apps Script. If it is `relay_redirect`, the next root-cause task investigates
Worker access to Google Content Service. Do not delete any secret and do not
claim Telegram delivery is fixed.
