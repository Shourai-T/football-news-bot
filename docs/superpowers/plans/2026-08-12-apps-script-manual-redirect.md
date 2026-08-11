# Apps Script Manual Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deployed Cloudflare Worker safely follow the Google Apps Script Content Service redirect so Telegram relay calls can complete.

**Architecture:** `TelegramClient` will send the signed relay envelope once with manual redirect handling. It will follow only a 302 or 303 to the exact HTTPS host `script.googleusercontent.com`, using a bodyless GET with the same timeout signal, and then reuse the existing relay-response parser.

**Tech Stack:** TypeScript 7, Cloudflare Workers `fetch`, Vitest 4, Wrangler 4.

## Global Constraints

- Use one `AbortSignal.timeout(8_000)` signal for the complete two-request exchange.
- The first request is POST with `redirect: "manual"` and contains `{ secret, chatId, method, body }`.
- The second request is GET with `redirect: "error"`, no headers, no body, and no secret or chat metadata.
- Follow only HTTP 302 or 303 to an absolute `https://script.googleusercontent.com/...` URL.
- Reject HTTP, lookalike domains, subdomains, trailing-dot hosts, user-info URLs, missing locations, and every other redirect status before making a second request.
- Preserve fixed, redacted errors; never include redirect URLs, relay secrets, or response bodies.
- Preserve cron, D1, Gemini, RSS, webhook, Telegram callback, and X-related behavior.
- Do not remove the Cloudflare `TELEGRAM_BOT_TOKEN` secret until the live health check returns `{"status":"ok"}`.

---

### Task 1: Implement the guarded Apps Script redirect flow

**Files:**
- Modify: `test/telegram.test.ts`
- Modify: `src/telegram.ts`

**Interfaces:**
- Consumes: existing `TelegramConfig { relayUrl: string; relaySecret: string; chatId: string }` and injected `typeof fetch`.
- Produces: private relay fetch behavior that either returns a direct `Response` or a validated second-hop `Response`; public `TelegramClient` methods remain unchanged.

- [ ] **Step 1: Add a failing happy-path redirect test**

Add this test inside `describe("TelegramClient", ...)`:

```ts
it.each([302, 303])("follows a Google Apps Script %s redirect with a bodyless GET", async (status) => {
  const redirectUrl = "https://script.googleusercontent.com/macros/echo?user_content_key=opaque";
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return calls.length === 1
      ? new Response(null, { status, headers: { location: redirectUrl } })
      : relayResponse({ ok: true, result: { id: 8702486864 } });
  };

  await expect(client(fetcher).checkHealth()).resolves.toBeUndefined();
  expect(calls).toHaveLength(2);
  expect(calls[0]?.input).toBe(RELAY_URL);
  expect(calls[0]?.init?.method).toBe("POST");
  expect(calls[0]?.init?.redirect).toBe("manual");
  expect(relayBody(calls[0]?.init).secret).toBe(RELAY_SECRET);
  expect(calls[1]).toEqual({
    input: redirectUrl,
    init: {
      method: "GET",
      redirect: "error",
      signal: calls[0]?.init?.signal,
    },
  });
});
```

- [ ] **Step 2: Run the happy-path test and verify RED**

Run:

```bash
npm test -- telegram.test.ts -t "follows a Google Apps Script"
```

Expected: FAIL because the current first request does not set `redirect: "manual"` and never performs a second GET.

- [ ] **Step 3: Add failing redirect rejection and second-fetch error tests**

Add parameterized rejection coverage:

```ts
it.each([
  [301, "https://script.googleusercontent.com/macros/echo"],
  [307, "https://script.googleusercontent.com/macros/echo"],
  [302, "http://script.googleusercontent.com/macros/echo"],
  [302, "https://script.googleusercontent.com.evil.test/macros/echo"],
  [302, "https://sub.script.googleusercontent.com/macros/echo"],
  [302, "https://script.googleusercontent.com./macros/echo"],
  [302, "https://user@script.googleusercontent.com/macros/echo"],
])("rejects relay redirect status %s and target %s", async (status, location) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, {
    status,
    headers: { location },
  }));

  await expect(client(fetcher).checkHealth()).rejects.toThrow("telegram_relay_redirect_error");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects a redirect without a location before a second fetch", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302 }));

  await expect(client(fetcher).checkHealth()).rejects.toThrow("telegram_relay_redirect_error");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("redacts a rejected fetch after a valid relay redirect", async () => {
  const createFetcher = () => vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://script.googleusercontent.com/macros/echo?private=value" },
    }))
    .mockRejectedValueOnce(new TypeError("private transport detail"));

  await expect(client(createFetcher()).checkHealth()).rejects.toMatchObject({
    message: "telegram_network_error",
    transport: "fetch_rejected",
  });
  await expect(client(createFetcher()).checkHealth()).rejects.not.toThrow("private transport detail");
});
```

- [ ] **Step 4: Run all new redirect tests and verify RED**

Run:

```bash
npm test -- telegram.test.ts -t "redirect"
```

Expected: FAIL because invalid redirects are currently treated as ordinary relay responses and second-hop failures cannot occur.

- [ ] **Step 5: Implement the minimum guarded redirect helper**

In `src/telegram.ts`, create the timeout signal once in `#request`, set the first request's redirect mode, and resolve the response inside the existing redacted fetch `try/catch`:

```ts
const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
response = await followAppsScriptRedirect(response, this.fetcher, signal);
```

Add these module-private helpers:

```ts
async function followAppsScriptRedirect(
  response: Response,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  if (!isRedirectStatus(response.status)) {
    if (response.status >= 300 && response.status < 400) {
      throw new Error("telegram_relay_redirect_error");
    }
    return response;
  }

  const location = response.headers.get("location");
  if (location === null || !isAllowedAppsScriptRedirect(location)) {
    throw new Error("telegram_relay_redirect_error");
  }

  return fetcher(location, {
    method: "GET",
    redirect: "error",
    signal,
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 302 || status === 303;
}

function isAllowedAppsScriptRedirect(location: string): boolean {
  try {
    const url = new URL(location);
    return url.protocol === "https:" &&
      url.hostname === "script.googleusercontent.com" &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}
```

Keep both fetches inside the current `try/catch` so timeout and rejected-fetch classification remains fixed and redacted.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test -- telegram.test.ts
```

Expected: the complete Telegram suite passes with no warning or unhandled rejection.

- [ ] **Step 7: Run the full local gate**

Run:

```bash
npm run typecheck && npm test && npm run lint && npx wrangler deploy --dry-run && git diff --check
```

Expected: every command exits 0; all Vitest suites pass; Wrangler produces a dry-run bundle without deploying.

- [ ] **Step 8: Review and commit Task 1**

Review the staged diff against every Global Constraint. If the review requires a behavior change, add a failing regression test before modifying production code, then repeat Steps 6 and 7. Stage only `src/telegram.ts` and `test/telegram.test.ts`, then commit:

```bash
git add src/telegram.ts test/telegram.test.ts
git commit -m "fix: handle Apps Script relay redirect"
```

### Task 2: Deploy and verify the transport fix

**Files:**
- No source files expected.
- Inspect: `src/diagnostic.ts`, `src/index.ts`, `wrangler.jsonc`.

**Interfaces:**
- Consumes: the deployed `POST /internal/telegram-health` endpoint and Cloudflare secret `DIAGNOSTIC_SECRET`.
- Produces: live evidence that Worker -> Apps Script -> Telegram completes, without exposing any secret.

- [ ] **Step 1: Push the reviewed branch**

Run:

```bash
git push origin feat/cloud-football-news-bot
```

Expected: origin advances through the design, plan, and implementation commits.

- [ ] **Step 2: Deploy the exact reviewed branch**

Run:

```bash
npx wrangler deploy
```

Expected: Wrangler reports the Worker URL and a new deployment version ID without changing D1 or secrets.

- [ ] **Step 3: Establish a known temporary diagnostic secret**

Generate the value in the current shell and upload the same value without printing it:

```bash
DIAGNOSTIC_SECRET="$(openssl rand -hex 32)"
printf '%s' "$DIAGNOSTIC_SECRET" | npx wrangler secret put DIAGNOSTIC_SECRET
```

Expected: Wrangler confirms the secret upload; the value remains only in the shell variable and Cloudflare.

- [ ] **Step 4: Run the live health probe**

Run:

```bash
curl --silent --show-error --fail-with-body \
  --request POST "https://football-news-bot.football-news-bot.workers.dev/internal/telegram-health" \
  --header "X-Diagnostic-Secret: $DIAGNOSTIC_SECRET"
unset DIAGNOSTIC_SECRET
```

Expected success evidence:

```json
{"status":"ok"}
```

If the result remains `fetch_rejected`, stop: the redirect hypothesis is disproved and no Cloudflare secret is deleted.

- [ ] **Step 5: Preserve secrets until success is confirmed**

Only after Step 4 returns the exact success response may a later cleanup task remove the legacy `TELEGRAM_BOT_TOKEN` and temporary diagnostic endpoint. This plan performs no secret deletion.
