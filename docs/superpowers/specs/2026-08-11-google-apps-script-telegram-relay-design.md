# Google Apps Script Telegram Relay Design

## Goal

Route every outbound Telegram Bot API request through the verified Google Apps Script relay because direct Cloudflare Worker requests to `api.telegram.org` are rejected before an HTTP response is received.

## Evidence

The same bot token succeeds from the operator's Mac. Gemini succeeds from the Worker. The authenticated Worker `getMe` probe consistently returns `telegram_network_error` with `transport: fetch_rejected`. The Apps Script relay's `getMe` request returned Telegram HTTP 200.

## Architecture

The Worker sends `{ secret, method, body }` as JSON to `TELEGRAM_RELAY_URL`. The relay validates its shared secret, allows only `getMe`, `sendMessage`, `answerCallbackQuery`, and `editMessageText`, validates `chat_id` when present, then calls Telegram with the bot token held in Google Script Properties. The relay returns a JSON envelope containing only `ok`, `status`, and Telegram's JSON body.

`TelegramClient` becomes a relay client. It preserves `telegram_timeout`, `telegram_network_error`, and `telegram_api_error:<status>` behavior for callers, but does not call `api.telegram.org` from Cloudflare. Webhook validation continues to use `TELEGRAM_CHAT_ID` and `TELEGRAM_WEBHOOK_SECRET`; it does not require the bot token.

## Secret placement

Google Apps Script Script Properties retain `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `RELAY_SHARED_SECRET`. Cloudflare retains `TELEGRAM_RELAY_URL`, `TELEGRAM_RELAY_SECRET`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `DIAGNOSTIC_SECRET`, `GEMINI_API_KEY`, and `GEMINI_MODEL`. After the Worker deployment and relay health check pass, `TELEGRAM_BOT_TOKEN` is deleted from Cloudflare.

## Error handling

The Worker gives the relay request the existing eight-second timeout. A rejected Worker-to-relay fetch preserves timeout versus network categories. A malformed relay envelope, non-200 relay HTTP response, or relay rejection produces fixed redacted errors. Telegram's nested status code remains the only provider detail reflected to pipeline code. No relay secret, Telegram token, raw exception text, request body, or response body is logged or returned from Worker routes.

## Verification

Tests prove all Telegram methods use the relay envelope, the relay secret never appears in a URL, relay response validation rejects malformed data, Telegram's nested failure status is preserved, and the health probe executes `getMe` through the relay. Configuration tests prove the old Cloudflare bot-token secret is absent and the two relay secrets are absent from versioned configuration.

## Scope

The relay source is committed under `relay/Code.gs` as the reviewed deployment source. No X API integration, retry policy, scheduler change, D1 change, or additional third-party service is included. The temporary diagnostic endpoint is retained until a deployed relay health check has passed.
