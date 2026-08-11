# Telegram Transport Diagnostic Design

## Goal

Classify a failed Worker-to-Telegram `getMe` request without returning a token, URL, provider response, or raw exception text.

## Context

The existing authenticated `POST /internal/telegram-health` probe returned HTTP 502 with `telegram_network_error`. The same bot token succeeds from the operator's Mac, and Gemini succeeds from the Worker. The remaining failed boundary is the Worker transport to Telegram.

## Options considered

1. Return the caught exception message. This may disclose the bot-token URL or provider internals. Rejected.
2. Preserve a safe transport classification from the Telegram client and expose it only through the authenticated diagnostic endpoint. Recommended.
3. Add a relay or retry immediately. This would mask an unknown transport failure and add new infrastructure before establishing the cause. Rejected.

## Design

`TelegramClient` will expose only a stable failure category for a failed request: `timeout` when the request aborts, and `fetch_rejected` for every other rejected `fetch`. The client will keep existing public error categories for pipeline behavior.

The authenticated diagnostic route will respond with the stable `transport` field alongside the existing `status` and `category`. It will never serialize the original `Error`, its message, URL, token, or response body. Normal pipeline logging stays redacted.

## Verification

Route tests will prove that an aborted request returns `transport: "timeout"` and an arbitrary rejected request returns `transport: "fetch_rejected"`; the latter test will contain a deliberately secret-looking error message and assert that none of it reaches the response or log output.

## Scope

No retry, relay, proxy, Gemini call, Telegram message, scheduling change, or database change is included. The diagnostic endpoint and temporary secret remain temporary and will be removed after the root cause is established.
