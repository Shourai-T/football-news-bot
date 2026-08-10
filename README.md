# Football News Bot

A Cloudflare Worker that reads configured public football RSS/Atom feeds five times per day, drafts one factual English post with Gemini, and sends it to a private Telegram chat for approval or rejection. Approval is a durable D1 state only: this MVP contains no X integration or publishing code.

## Safety boundary

Use public RSS or Atom endpoints only. Do not scrape club websites or article pages. Verify each configured feed before deployment. Keep Telegram and Gemini values in Wrangler secrets; never add real credentials to `wrangler.jsonc`, `.dev.vars.example`, shell history, logs, or source control.

## Install and test

```sh
npm install
npm test
npm run typecheck
```

For local development, copy `.dev.vars.example` to `.dev.vars` and populate it with development-only values. `.dev.vars` is ignored by Git.

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

Set all five secret fields. Wrangler prompts for each value without storing it in the repository:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GEMINI_MODEL
```

Review the versioned `RSS_FEEDS_JSON` value in `wrangler.jsonc`. It is public configuration and remains directly editable. It initially contains verified RSS endpoints for BBC Sport Football, Sky Sports Football, and Liverpool FC; remove or replace a source if it stops returning RSS/Atom.

Validate the bundle without changing remote state, then deploy only after reviewing the configuration:

```sh
npx wrangler deploy --dry-run
npx wrangler deploy
```

## Telegram webhook

After deployment, register the Worker URL with Telegram. Replace every angle-bracket placeholder locally; do not commit the resulting command or token.

```sh
curl --request POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  --header "content-type: application/json" \
  --data '{"url":"https://<WORKER_HOST>/telegram","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["callback_query"]}'
```

The Worker accepts POST requests only. It verifies Telegram's secret header and the configured chat ID before changing a draft. Approval and rejection callbacks use compact `a:<draft-id>` and `r:<draft-id>` payloads.

## Operations

Stream structured Worker logs without exposing request bodies or secrets:

```sh
npx wrangler tail
```

The Cron expression in `wrangler.jsonc` runs at `01:07`, `04:07`, `07:07`, `10:07`, and `13:07` UTC, corresponding to `08:07`, `11:07`, `14:07`, `17:07`, and `20:07` in `Asia/Ho_Chi_Minh`. D1 prevents duplicate slots and URLs, and caps Gemini reservations at five per Vietnam calendar date.

To stop callbacks before retiring or replacing the Worker, remove the webhook:

```sh
curl --request POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook" \
  --header "content-type: application/json" \
  --data '{"drop_pending_updates":false}'
```

Use `npx wrangler secret delete <SECRET_NAME>` only when deliberately rotating or decommissioning a secret.
