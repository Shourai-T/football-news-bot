# Final fix report

## Root causes and fixes

- Gemini output had no application-level size bound, while Telegram adds source
  and status suffixes. A 3,000-character draft limit is enforced locally,
  requested in the Gemini prompt, and supported by `maxOutputTokens: 1024`.
  Telegram formatting independently truncates source and edit text to its
  4,096-character limit.
- Ranking treated every future timestamp as fresh. Candidates now allow only
  five minutes of explicit publisher clock skew.
- Callback validation checked the chat but not the originating message. It now
  rejects callbacks whose `message_id` differs from the draft's stored Telegram
  message ID before state transition.
- The Worker routed all POST paths to the Telegram handler. Only `POST
  /telegram` now reaches it.
- README claimed structured logs while the Worker emitted plain strings.
  Scheduled and webhook error events now emit JSON with safe event metadata.
- The design promised scheduled record pruning with no approved retention
  policy. Pruning is explicitly deferred in the design and README; this avoids
  unsafe deletion of audit data.

## RED evidence

`npm test -- test/gemini.test.ts test/telegram.test.ts test/ranking.test.ts test/webhook.test.ts test/pipeline.test.ts`

Failed as expected: 7 new regressions failed (unbounded Gemini and Telegram
text, future ranking, callback message mismatch, and non-`/telegram` POST
routing); 35 existing tests passed.

`npm test -- test/pipeline.test.ts`

Failed as expected: the Gemini failure lifecycle emitted plain
`gemini_api_error` instead of safe structured event metadata; 11 other tests
passed.

## GREEN and final verification

- Focused suite: `npm test -- test/gemini.test.ts test/telegram.test.ts test/ranking.test.ts test/webhook.test.ts test/pipeline.test.ts` — 42/42 passed.
- Full suite: `npm test` — 9 files, 61/61 passed. The sandbox initially blocked
  Vitest's loopback test-worker port; the same local-only command passed when
  allowed to bind that port.
- `npm run typecheck` — passed.
- `WRANGLER_LOG_PATH=/tmp/football-news-bot-final-review-wrangler.log npx wrangler deploy --dry-run` — passed; no remote deployment.
- `git diff --check` — passed.

## Files changed

`src/limits.ts`, `src/gemini.ts`, `src/telegram.ts`, `src/ranking.ts`,
`src/webhook.ts`, `src/index.ts`, `src/pipeline.ts`, `README.md`,
`docs/superpowers/specs/2026-08-10-football-news-bot-cloud-design.md`, and the
focused Gemini, Telegram, ranking, pipeline, and webhook tests.

## Commit

Implementation commit SHA: `35cebc9ba42aed2446c63286f0c979b3b8faeb8a`.

Final command outputs (2026-08-11): `npm test` — 9 files and 61/61 tests
passed; `npm run typecheck` — passed; `WRANGLER_LOG_PATH=/tmp/football-news-bot-final-review-wrangler.log npx wrangler deploy --dry-run` — bundle validation passed with no deployment; `git diff --check` — passed.
