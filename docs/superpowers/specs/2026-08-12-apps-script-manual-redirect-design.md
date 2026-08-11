# Apps Script Manual Redirect Design

Date: 2026-08-12
Status: approved concept, written design pending review

## Problem

The Google Apps Script relay succeeds when called from the user's Mac with
`curl --location`, but the deployed Cloudflare Worker reports
`telegram_network_error` with transport `fetch_rejected` before it can parse a
relay response. The current Worker sends one POST request and lets `fetch`
automatically follow redirects.

Apps Script Content Service serves responses through a redirected
`script.googleusercontent.com` URL. The working curl test and the Worker-only
failure make automatic cross-origin redirect handling the leading hypothesis.
This remains a hypothesis until the deployed health endpoint succeeds after the
change.

## Decision

Handle the Apps Script response redirect explicitly inside `TelegramClient`.
Keep the relay request protocol, timeout budget, response validation, and error
redaction unchanged.

## Request Flow

1. Create one eight-second timeout signal for the entire relay exchange.
2. POST the signed relay envelope to the configured Apps Script `/exec` URL
   with `redirect: "manual"`.
3. If the first response is not a redirect, parse it through the existing relay
   response path. This preserves compatibility with test and future relay
   endpoints that respond directly.
4. Follow only HTTP 302 or 303 responses that contain an absolute URL meeting
   both conditions:
   - protocol is exactly `https:`;
   - hostname is exactly `script.googleusercontent.com`.
5. Fetch the validated redirect destination with GET, `redirect: "error"`, the
   same timeout signal, no request body, and no relay headers.
6. Parse only the second response as the relay response.

## Security Properties

- The relay secret, chat ID, Telegram method, and Telegram request body appear
  only in the first POST.
- No sensitive header or POST body is forwarded to the redirected host.
- Redirects to HTTP, lookalike domains, subdomains, trailing-dot variants,
  user-info URLs, or any host other than the exact allowlisted Google host are
  rejected before a second request.
- A second redirect is rejected instead of followed.
- Errors expose only fixed internal categories; redirect URLs and response
  bodies are never included in errors or diagnostic responses.

## Failure Handling

- A timeout in either fetch is reported as `telegram_timeout` with transport
  `timeout`.
- A rejected fetch in either step is reported as `telegram_network_error` with
  transport `fetch_rejected`.
- A missing or disallowed redirect target is reported as a fixed
  `telegram_relay_redirect_error`.
- Existing invalid-envelope, relay-denial, and Telegram API error behavior is
  unchanged.

## Tests

Add focused tests that prove:

- the initial relay POST uses manual redirect handling;
- a valid Google 302/303 redirect causes exactly one GET;
- the GET has no body, content-type header, relay secret, or chat metadata;
- both requests share the same eight-second timeout signal;
- HTTP targets, lookalike hosts, subdomains, and other redirect statuses are
  rejected without a second fetch;
- a direct non-redirect relay response still works;
- a fetch rejection during the second request retains the existing redacted
  network-error classification.

Run the full typecheck, test suite, lint, and deployment dry-run after the
focused tests pass.

## Deployment Verification

Deploy the Worker without changing cron, D1, Gemini, webhook, or relay secrets.
Regenerate the temporary diagnostic secret if needed, then call
`POST /internal/telegram-health`. A response of `{"status":"ok"}` confirms the
hypothesis and the transport fix. Keep the old Telegram bot-token secret until
this live check passes.

## Out of Scope

- Replacing Apps Script with another relay provider.
- Apps Script Execution API and OAuth.
- Changes to RSS selection, Gemini generation, D1, cron schedules, Telegram
  callback semantics, or X posting.
