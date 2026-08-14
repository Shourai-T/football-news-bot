# X Posting Mode Control Design

**Date:** 2026-08-14

## Goal

Add a private Telegram control panel that makes the intended X publishing mode explicit and durable before X publishing is implemented. The mode is stored in Supabase and survives Edge Function deployments.

The design prepares three modes:

- `off`: Telegram draft generation and approval continue, but approval triggers no X action.
- `manual`: a future phase will expose an `Open in X` button after approval.
- `auto`: a future phase will publish through the X API after approval.

This phase keeps `manual` and `auto` locked. The only selectable mode is `off`. A mode must never appear enabled before its behavior exists.

## Scope

### Included

- A singleton Supabase setting for the X posting mode.
- A `/xmode` command available only in the configured private Telegram chat.
- An inline mode panel showing the current mode and locked future modes.
- Authenticated callbacks for the panel.
- Telegram webhook registration for both `message` and `callback_query` updates.
- Automated database, repository, Telegram client, and webhook tests.
- Deployment and operator verification instructions.

### Excluded

- Opening the X composer.
- Generating X-specific 280-character copy.
- Posting through the X API.
- X credentials, retries, posting history, or reconciliation.
- Changing the existing draft Approve/Reject state machine.

## Telegram Experience

Sending `/xmode` in the configured private chat makes the bot reply with:

```text
X posting mode: OFF

[OFF ✓] [MANUAL 🔒] [AUTO 🔒]
```

Behavior:

- Pressing `OFF ✓` answers `Already OFF` and leaves the stored setting unchanged.
- If a future mode is ever present, pressing `OFF` durably changes it to `off`
  before refreshing the panel. A later Telegram failure must not roll back this
  emergency stop.
- Pressing `MANUAL 🔒` answers `Manual mode is coming soon` and leaves the setting unchanged.
- Pressing `AUTO 🔒` answers `Auto mode is not configured` and leaves the setting unchanged.
- Commands and callbacks from any other chat are rejected without reading or mutating settings.
- Non-command messages are ignored.
- Existing draft callbacks `a:<draft-id>` and `r:<draft-id>` retain their current behavior.

Telegram callback data stays compact:

- `xm:off`
- `xm:manual`
- `xm:auto`

## Persistence

Add `public.bot_settings` as a singleton table:

```text
id             smallint primary key, constrained to 1
x_posting_mode text, constrained to off/manual/auto
updated_at     timestamptz
```

The migration inserts row `id = 1` with mode `off`. RLS is enabled, public/anonymous/authenticated access is revoked, and only `service_role` receives the access required by the Edge Functions.

The repository exposes:

- `getXPostingMode(): Promise<XPostingMode>`
- `setXPostingMode(mode, now): Promise<XPostingMode>`

Although the repository supports all three valid database values, the webhook in this phase only permits selecting `off`. This keeps persistence ready for later phases without advertising incomplete behavior.

Missing, duplicated, or invalid singleton state is treated as a repository error. The bot must not silently assume a mode when persistent state is corrupt.

## Webhook Architecture

The existing Telegram webhook remains the single ingress:

1. Require `POST`.
2. Load and validate `TELEGRAM_WEBHOOK_SECRET` before reading unrelated configuration.
3. Parse the Telegram update.
4. Load the configured bot token and chat ID.
5. Reject updates from any chat other than `TELEGRAM_CHAT_ID`.
6. Route an exact `/xmode` command to the settings panel.
7. Route `xm:*` callbacks to the mode controller.
8. Route existing `a:*` and `r:*` callbacks to the unchanged draft decision flow.
9. Ignore unsupported update types and ordinary messages.

The webhook setup helper changes `allowed_updates` from only `callback_query` to:

```json
["message", "callback_query"]
```

The command parser accepts `/xmode` and Telegram's group-style `/xmode@<bot-name>` form, but authorization remains based solely on the configured chat ID. No username is trusted as an identity boundary.

## Component Boundaries

### Domain types

Define `XPostingMode = "off" | "manual" | "auto"`. Parsing database values is strict.

### Repository

Owns all reads and writes for the singleton setting and translates Supabase failures or invalid row counts into redacted repository errors.

### Telegram client

Owns rendering and sending the mode panel plus answering its callbacks. It does not decide which modes are available.

### Webhook handler

Owns authentication, update routing, availability policy, and orchestration. It never accepts a requested locked mode merely because it is a valid database enum value.

## Failure Handling

- Invalid webhook secret: `401`, before database or Telegram provider access.
- Invalid or foreign-chat update: `400` or `403`, with no setting mutation.
- Settings read failure: `500 database_error`; do not render an invented mode.
- Initial Telegram panel send failure: `502 provider_error`; no setting mutation has occurred.
- Telegram failure after a successful transition to `off`: `502 provider_error`; retain the durable `off` setting.
- Locked-mode callback: return `200` after answering the callback; do not write to Supabase.
- Repeated `off` callback: idempotent, with no database write.

Logs contain categories and identifiers only. Bot tokens, webhook secrets, Supabase keys, Telegram payload text, and future X content are never logged.

## Testing

Tests must prove:

- The migration creates exactly one default `off` setting with constraints, RLS, and service-role-only access.
- Repository reads and strictly validates the singleton.
- Repository updates supported values with an explicit timestamp.
- `/xmode` from the configured chat renders the expected panel.
- Ordinary messages are ignored.
- Foreign chats cannot read or modify the mode.
- `xm:off` is idempotent.
- Locked callbacks answer clearly and perform no write.
- Existing Approve/Reject callback tests remain green.
- Webhook configuration requests both required Telegram update types.
- All provider requests retain the existing eight-second timeout and redacted error behavior.

## Rollout

1. Apply the Supabase migration and verify the singleton row is `off`.
2. Deploy the Telegram webhook Edge Function.
3. Re-register the webhook so Telegram sends both `message` and `callback_query` updates.
4. Send `/xmode` from the configured private chat.
5. Verify the panel shows `OFF` and both future modes are locked.
6. Press each button and confirm the database remains `off`.
7. Approve one normal draft and confirm its existing behavior is unchanged.

Rollback restores the previous webhook function and `allowed_updates` configuration. The new table may remain safely at `off`; dropping it is unnecessary and would be destructive.

## Future Phases

The manual phase will add X-specific copy constrained to X's weighted character limit, unlock `manual`, and render `Open in X` only after a successful approval. The auto phase will require X API credentials, exactly-once publishing semantics, durable attempt history, reconciliation, and an emergency transition back to `off` before `auto` can be unlocked.
