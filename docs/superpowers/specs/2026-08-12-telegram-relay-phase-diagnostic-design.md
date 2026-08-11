# Telegram Relay Phase Diagnostic Design

Date: 2026-08-12
Status: approved

## Context

The deployed Worker still returns the following protected health response after
manual Apps Script redirect handling was deployed:

```json
{"status":"unavailable","category":"telegram_network_error","transport":"fetch_rejected"}
```

The same fixed error currently represents two different boundaries:

1. Worker POST to the configured Apps Script `/exec` URL.
2. Worker GET to the validated `script.googleusercontent.com` redirect URL.

No further transport fix is justified until the failing boundary is known.

## Approaches Considered

### Chosen: fixed phase in the protected health response

Attach one of two non-sensitive phase values to fetch failures:
`relay_post` or `relay_redirect`. Return the value only from the existing
secret-protected health endpoint. This is deterministic, works with the current
curl workflow, and does not depend on a live log session.

### Rejected: fixed phase only in Cloudflare tail logs

This would remain safe, but it requires coordinating `wrangler tail` with a
second request and makes the result harder for the user to reproduce. It adds
operational friction without providing more evidence.

### Rejected: expose the original exception

Raw fetch exceptions, redirect URLs, response bodies, and request data can
contain provider or secret-adjacent information. Exposing them is unnecessary
and violates the existing redaction boundary.

## Design

Extend `TelegramRequestError` with an optional phase whose type is exactly:

```ts
type TelegramRequestPhase = "relay_post" | "relay_redirect";
```

The initial relay POST and redirected GET receive separate fetch error
classification boundaries:

- a rejected or timed-out initial POST creates `TelegramRequestError` with
  phase `relay_post`;
- a rejected or timed-out redirected GET creates `TelegramRequestError` with
  phase `relay_redirect`;
- redirect validation failures keep the fixed
  `telegram_relay_redirect_error` and do not pretend to be transport failures;
- response parsing and nested Telegram API errors keep their current behavior.

`handleTelegramHealth` includes `phase` only when the caught error is a
`TelegramRequestError` with one of the two allowed values. The protected JSON
failure response becomes one of:

```json
{"status":"unavailable","category":"telegram_network_error","transport":"fetch_rejected","phase":"relay_post"}
```

```json
{"status":"unavailable","category":"telegram_network_error","transport":"fetch_rejected","phase":"relay_redirect"}
```

The console log may include the same fixed phase but never the raw exception.

## Security Constraints

- Do not log or return the relay URL, redirect URL, relay secret, Telegram bot
  token, chat ID, request body, response body, or original exception text.
- Keep the endpoint protected by `X-Diagnostic-Secret`.
- Do not add query-string diagnostics or bypass the existing secret check.
- Do not change Cloudflare secrets, Apps Script properties, D1, cron, Gemini,
  RSS, Telegram callback behavior, or X-related behavior.
- Do not delete `TELEGRAM_BOT_TOKEN` while the relay remains unhealthy.

## Tests

Use TDD to prove:

- an initial fetch rejection reports phase `relay_post`;
- an initial timeout reports phase `relay_post` and transport `timeout`;
- a redirected fetch rejection reports phase `relay_redirect`;
- a redirected fetch timeout reports phase `relay_redirect` and transport
  `timeout`;
- the protected diagnostic response and fixed console event include the phase;
- raw exception text and URLs remain absent from responses and logs;
- arbitrary non-transport errors retain the existing redacted diagnostic shape
  without a fabricated phase.

Run the focused tests, full typecheck, all tests, lint, diff check, and Wrangler
deployment dry-run before committing or deploying.

## Live Verification

Deploy the diagnostic-only change, establish a known temporary
`DIAGNOSTIC_SECRET`, and call `POST /internal/telegram-health` once. The exact
phase identifies the next investigation boundary:

- `relay_post`: investigate Cloudflare Worker access to Apps Script itself;
- `relay_redirect`: investigate Cloudflare Worker access to the Google Content
  Service response host and redirect-response contract.

This deployment diagnoses the boundary; it does not claim to fix Telegram
delivery. After evidence is captured, create a separate root-cause fix and
later remove the temporary diagnostic endpoint and secret.

## Secret Handling

The user must not paste API keys or bot tokens into chat. Existing Cloudflare
secrets are sufficient for this diagnostic. If any secret must be replaced, the
user enters it directly through `wrangler secret put`, or an ephemeral local
shell variable is piped into Wrangler without printing it.
