# Football News Bot

A Cloudflare Worker that reads configured public football RSS/Atom feeds five times per day, drafts one factual English post with Gemini, and sends it to a private Telegram chat for approval or rejection. Approval is a durable D1 state only: this MVP contains no X integration or publishing code.

## Safety boundary

Use public RSS or Atom endpoints only. Do not scrape club websites or article pages. Verify each configured feed before deployment. Keep Gemini and Worker relay values in Wrangler secrets; keep the Telegram bot token exclusively in Google Apps Script Script Properties. The relay shared-secret value is stored under separate names in Apps Script and Cloudflare. Never add credential values to `wrangler.jsonc`, `.dev.vars.example`, shell history, logs, or source control.

## Install and test

```sh
npm install
npm test
npm run typecheck
```

For local development, copy `.dev.vars.example` to `.dev.vars` and populate it with development-only values. `.dev.vars` is ignored by Git.

## Google Apps Script Telegram relay

The Worker never calls the Telegram Bot API directly. Outbound `getMe`, `sendMessage`, `answerCallbackQuery`, and `editMessageText` requests go through the versioned relay at `relay/Code.gs`.

1. Create a standalone Google Apps Script project and paste in `relay/Code.gs`.
2. In **Project Settings**, add these Script Properties with values known only to the operator: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `RELAY_SHARED_SECRET`. Use the same shared-secret value later for Cloudflare's `TELEGRAM_RELAY_SECRET`.
3. Deploy it as a **Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**, then copy the Web app URL. Create a new deployment after changing the source.

Before configuring Cloudflare, verify the relay from a terminal. Substitute values locally; do not save the command with its substituted values or expose the response body:

```sh
curl "<TELEGRAM_RELAY_URL>" \
  --header "content-type: application/json" \
  --data '{"secret":"<RELAY_SHARED_SECRET>","method":"getMe","body":{}}'
```

The successful envelope has `ok: true`, status `200`, and a serialized Telegram response body. The relay accepts only the four outbound methods listed above and rejects a request whose `chat_id` is not the configured chat.

## Cloudflare setup and deployment

Authenticate Wrangler:

```sh
npx wrangler login
```

Create the D1 database once, then copy the returned non-secret database ID into the `database_id` field in `wrangler.jsonc`:

```sh
npx wrangler d1 create football-news-bot
```

Apply the migration to the remote database:

```sh
npx wrangler d1 migrations apply DB --remote
```

Set the seven Cloudflare runtime secrets. Set `TELEGRAM_RELAY_SECRET` to the same value held by Apps Script as `RELAY_SHARED_SECRET`; the Telegram bot token is not a Cloudflare secret:

```sh
npx wrangler secret put TELEGRAM_RELAY_URL
npx wrangler secret put TELEGRAM_RELAY_SECRET
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put DIAGNOSTIC_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GEMINI_MODEL
```

Review the versioned `RSS_FEEDS_JSON` value in `wrangler.jsonc`. It is public configuration and remains directly editable. It initially contains verified RSS endpoints for BBC Sport Football, Sky Sports Football, and Liverpool FC; remove or replace a source if it stops returning RSS/Atom.

Validate the bundle without changing remote state, then deploy only after reviewing the configuration:

```sh
npx wrangler deploy --dry-run
npx wrangler deploy
```

Run the relay health diagnostic after deployment. It sends `getMe` through the relay, does not call Gemini, and does not return bot details:

```sh
curl "https://<WORKER_HOST>/internal/telegram-health" \
  --header "X-Diagnostic-Secret: <DIAGNOSTIC_SECRET>" \
  --data ''
```

After the deployment and relay health check pass, remove any legacy Cloudflare bot-token secret. This is required even if the current Worker version no longer binds it:

```sh
npx wrangler secret delete TELEGRAM_BOT_TOKEN
```

## Telegram webhook

The Worker accepts `POST /telegram` for callbacks. It verifies Telegram's secret header, configured chat ID, and stored Telegram message ID before changing a draft. Approval and rejection callbacks use compact `a:<draft-id>` and `r:<draft-id>` payloads. The separate temporary route `POST /internal/telegram-health` requires `DIAGNOSTIC_SECRET`.

Register or update the Telegram callback webhook through the operator-controlled Telegram configuration; it must target `https://<WORKER_HOST>/telegram`, use `TELEGRAM_WEBHOOK_SECRET`, and allow only `callback_query` updates. Do not route this setup through Cloudflare or record credential-bearing commands.

## Operations

Stream structured Worker logs without exposing request bodies or secrets:

```sh
npx wrangler tail
```

The Cron expression in `wrangler.jsonc` runs at `01:07`, `04:07`, `07:07`, `10:07`, and `13:07` UTC, corresponding to `08:07`, `11:07`, `14:07`, `17:07`, and `20:07` in `Asia/Ho_Chi_Minh`. D1 prevents duplicate slots and URLs, and caps Gemini reservations at five per Vietnam calendar date.

Historical D1 pruning is deferred in this MVP. Approval records remain intact; define and review a retention policy before adding deletion logic.

Use `npx wrangler secret delete <SECRET_NAME>` only when deliberately rotating or decommissioning a secret.
