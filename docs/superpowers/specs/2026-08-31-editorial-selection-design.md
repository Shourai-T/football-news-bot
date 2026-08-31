# Editorial Selection and RSS Reliability Design

**Date:** 2026-08-31

**Status:** Consolidated specification approved by the user on 2026-08-31.

**Target:** Existing Supabase bot on `feat/cloud-football-news-bot`.

## Goal and boundaries

Produce a more varied daily set of useful English football drafts without adding
Gemini requests. Improve the choice of story before asking Gemini to write it.
Editorial scores are transparent heuristics, not predictions or guarantees of X
views.

Keep these behaviors unchanged:

- Five scheduled slots per Vietnam day, with at most five reserved Gemini
  requests across scheduled and manual runs. Failures can result in fewer drafts.
- One generation request only after selecting a final candidate; no AI ranking,
  embeddings, repair calls, or automatic regeneration in this change.
- Telegram Approve/Reject, `/xmode`, OFF/MANUAL behavior and the approved-draft
  `Open in X` button. The user still presses Post on X. AUTO remains locked.
- Existing English generation prompt, output validation, body-only X intent and
  separate source link on Telegram.
- Supabase hosting, authentication, quota reservation and delivery compensation.

Excluded: X API integration, actual-post tracking, images, analytics, retention
cleanup, extra schedules, full-article scraping, proxies and paid news services.

## Evidence and motivation

The current selector sorts by source priority before topic score or freshness.
This allows BBC to win whenever it has any eligible article. An earlier database
sample contained only BBC among 83 selected articles; `articles` stores selections,
not every item fetched, so that sample alone cannot establish feed availability.

Read-only checks from the developer's Mac on 2026-08-31 found:

- BBC and Sky returned RSS with items.
- Sky supplied dates such as `Mon, 31 Aug 2026 09:54:00 BST`. The current native
  date parser returned `Invalid Date` locally. `rss.ts` silently discards such
  entries. This is a local reproduction, not a production-runtime verification.
- The configured Liverpool URL `https://www.liverpoolfc.com/?feed=rss2` returned
  HTML rather than RSS. The club's linked RSS information page also returned 404.
- ESPN's soccer feed returned parseable items, but technical availability is not
  permission to use it in the current rewriting/publishing workflow.

Changing ranking alone is therefore insufficient. Input reliability and
per-source diagnostics are prerequisites for meaningful diversity.

## Chosen approach

Use deterministic classification, scoring and diversity rules in the existing
scheduled pipeline. Do not add a separate planning service or daily queue.

```text
Verified RSS sources
  -> normalize and diagnose input
  -> reject ineligible/seen stories
  -> conservatively collapse duplicate events
  -> rank against today's delivered-draft history
  -> claim article and reserve existing Gemini quota
  -> one Gemini request
  -> existing Telegram approval -> manual Open in X
```

This was preferred over an AI ranking request each slot or an AI-generated daily
plan because it uses no additional Gemini quota and is reproducible in tests.

## Source registry and ingestion

Keep an explicit allowlist in `feed-config.ts`. Each enabled source has a stable
identifier, display name, HTTPS feed URL, editorial credibility score and source
kind (`publisher` or `official`). Source-specific date/confirmation rules are
explicit configuration, never inferred merely from a hostname containing a club
name. Existing stored source names map to the same stable identifiers.

Initial enabled set: BBC Sport Football and Sky Sports Football. Disable the
invalid Liverpool entry until a replacement passes verification. ESPN remains
disabled pending a usage review. Do not invent UEFA, FIFA, Premier League or club
feed endpoints to fill the list. With only two sources, any fifth draft in a day
necessarily uses the source soft-cap fallback.

A source is technically verified only after fetching it and checking RSS/Atom
structure, valid HTTPS article links, parseable publication times and recent
eligible entries. Recheck from the Supabase runtime before enabling it in
production. Availability does not establish reuse rights; review usage conditions
before adding a source. [ESPN RSS terms](https://www.espn.com/espn/news/story?page=rssinfo)
require review before enabling ESPN. The historical Liverpool discovery link is
on the [club's Stay Safe page](https://www.liverpoolfc.com/staysafe); a footer link
alone is not evidence of a working feed.

Parsing rules:

- Recognize RSS and Atom roots explicitly. HTTP 200 containing HTML or unrelated
  XML is a source error, distinct from a valid feed containing no items.
- Preserve the eight-second request timeout and independent feed fetching.
- Support explicit numeric offsets and standard GMT/UTC/ISO timestamps. For the
  verified Sky adapter only, interpret terminal BST as `+0100` and GMT as `+0000`.
  Do not reinterpret ambiguous timezone abbreviations for arbitrary feeds.
- Reject missing/invalid or timezone-less dates rather than assigning fetch time
  or relying on the host's local timezone. One bad item does not discard valid
  siblings.
- Keep HTTPS-only links and existing tracking removal. Also normalize the known
  BBC `at_medium` and `at_campaign` tracking parameters on BBC article hosts only.
  Do not strip arbitrary query parameters that may identify an article.
- Apply the same URL normalization to relevant stored history, so old tracking
  variants do not become new stories. Keep the database URL uniqueness guard.
  For BBC candidates, look up stored URLs for the exact candidate host/path as
  well as the normalized URL, and compare after normalization. This lookup is not
  age-limited: an old URL with a refreshed feed date is still seen. Match path
  boundaries, escape database pattern characters, paginate and retain meaningful
  query parameters; never load the entire archive merely to normalize URLs.

An `official` source is not automatically a confirmed announcement. Only an
explicit direct-announcement rule supported by the available feed text can grant
confirmation priority. Media-watch items, rumors and quoted third-party reports
do not qualify. Uncertain cases remain ordinary candidates. With no verified
official feed enabled initially, this preference is dormant rather than simulated.

## Hard eligibility rules

Before scoring, require a valid title, HTTPS canonical URL, valid publication
time, and relevance to the existing football topic allowlist.

- Article age must be at most 72 hours relative to the run timestamp.
- Preserve the current five-minute future clock-skew tolerance; larger future
  dates are ineligible. Clamp permitted small future offsets to age zero for scoring.
- Reject previously selected canonical URLs and high-confidence duplicate events
  identified within the eligible history window.
- Never relax age, URL deduplication, relevance or Gemini quota to fill a slot.
- If no candidate survives, finish `no_candidate` without generating a draft.

## Classification and event deduplication

Create pure, versioned editorial helpers independent of network and database code.
Input is the normalized title, excerpt, source metadata and publication time.
Output contains recognized entity IDs, one editorial type, confirmation evidence,
event comparison features and score components.

Normalize case, Unicode, punctuation and a curated alias list (for example,
Manchester United/Man Utd). Use whole-token/phrase matches and unique entity IDs;
repeated keywords cannot inflate scores. Do not infer unstated transfers, results,
injuries or confirmations.

Editorial types are `transfer`, `contract`, `injury`, `match`, `quote`, `stat` and
`general`. They describe the story, not the final Gemini prefix. Explicit event
facts take precedence over quote/stat presentation; ambiguous stories are
`general`. BREAKING/NEWS/OFFICIAL labels are not themselves factual evidence.

Conservative duplicate comparison:

1. Identical normalized canonical URLs always collide.
2. For different URLs, require the same supported event type, matching recognized
   entities and a matching event discriminator: transfer destination and stage,
   contract action, injury/return action, match opponents/date, a distinctive
   quotation, or a specific statistic.
3. Require strong normalized title overlap as additional evidence (initial token
   Jaccard threshold 0.80 after fixed stop-word removal). Conflicting destinations,
   stages, dates, scores or material numeric facts prevent a match.
4. Missing discriminators or uncertain matches remain separate. Merely sharing
   Ronaldo, Messi or a club is never enough. Generic stories only deduplicate by
   URL in this version.

Build groups deterministically and require agreement with every existing group
member; do not let chains of weak similarity merge unrelated events. Fixtures
must demonstrate the positive and negative cases for each supported comparator.
If reliable comparison for a type cannot be demonstrated, retain URL-only
deduplication for that type instead of lowering the confidence requirement.

Within an eligible current-feed group, prefer a supported direct official
confirmation, then editorial score, publication time and canonical URL as a final
stable tie-break. A previously selected matching event is suppressed rather than
sent again because an official source appeared later. Distinct developments,
such as rumor becoming a completed transfer, can remain separate events.

This is deliberately incomplete semantic deduplication. Paraphrases may escape
it; uncertain stories must not be removed on a speculative match.

## Ranking and daily diversity

Initial score is 0–100:

| Component | Range | Initial rule |
| --- | --- | --- |
| Event significance | 0–30 | Direct confirmed event 30; explicit transfer/contract/injury/match development 20; quote/stat 10; general 0 |
| Recognized subjects | 0–20 | Target player 10, target club 5, target competition 5; each category counted once |
| Freshness | 0–30 | Linear decay from 30 at age zero to 0 at 72 hours |
| Source credibility | 0–20 | Supported direct official confirmation 20; verified BBC/Sky reporting 15 |

Event significance uses the highest applicable tier, not their sum. The first
two components comprise the approved 0–50 topic/entity/event component. These are
initial editorial constants, not measured engagement scores. Exact matches on
source alone can no longer override all other factors.
Future verified official feeds use the ordinary reporting score of 15 unless
their item passes the direct-confirmation rule; adding any source requires an
explicit registry score and verification, not a default trust upgrade.

For each run, calculate counts from previously delivered drafts assigned to the
same Vietnam day:

- At most two from the same source when alternatives exist.
- At most two mentioning the same recognized club or player when alternatives
  exist. Count all recognized clubs/players once per draft, not just one selected
  primary entity. Competition names do not consume this entity cap.
- At most two of the same editorial type when alternatives exist.

First consider candidates that would keep every applicable count at two or less.
Choose the highest score, then newest publication time, then canonical URL.

If that set is empty, use all remaining hard-eligible candidates. Minimize the
sum of cap exceedances after adding a candidate across its source, type and
recognized entities (`max(0, resulting_count - 2)` per applicable dimension),
then maximize editorial score, freshness and the stable URL tie-break. Record
that fallback was used. This is the explicit meaning of "least repetitive";
the caps are preferences, not hard delivery limits.

Count a draft when its Telegram message ID is durably recorded and status is
pending, approved or rejected. Approval/rejection does not undo the fact the
user already received it. Failed drafts without confirmed delivery do not count.
Do not use article-row counts, approval time or assumed X publication counts.

Use `drafts.created_at`, which is currently the pipeline's run timestamp, to assign
the logical Vietnam day consistently with quota accounting. This is not an exact
Telegram delivery timestamp: a run crossing midnight belongs to its start day.
Use half-open day intervals; midnight in Vietnam is 17:00 UTC on the previous date.

## Persistence and component boundaries

Reuse existing tables; do not archive the whole feed or add a daily-plan table.

- `rss.ts`: transport, supported timestamp normalization, structural checks,
  URL normalization and per-feed diagnostics.
- Editorial helpers: deterministic entity/type/event features and score parts.
- `ranking.ts`: hard filters, event groups, diversity selection and a structured
  selection explanation. No database or provider calls.
- `repository.ts`: existing URL checks plus narrowly selected history reads:
  today's delivered drafts joined to articles, and previously selected articles
  whose publication timestamps fall within the current eligible window. The
  separate legacy BBC URL-equivalence lookup remains independent of that window.
- `pipeline.ts`: obtain history, select, then follow existing claim/reservation/
  generation/delivery sequence. It must not re-rank by spending another AI call.

History uses stored article title/excerpt/source/time and is classified by the
same version of the pure helpers as incoming stories. No data backfill or new
entity/type columns are needed. Retrieve only required columns and paginate
deterministically without silently truncating relevant history. Add narrowly
scoped indexes on `articles.published_at` and delivered `drafts.created_at` through
an additive migration. No permission expansion or deletion is required.

Preserve the existing policy that selected article rows remain seen after quota,
generation or delivery failure. Recent attempted events therefore suppress
equivalent alternative-source retries, while only delivered drafts affect daily
diversity. Changing failed-story retry policy is outside this task.

## Errors, concurrency and diagnostics

- One unavailable feed must not prevent selection from another usable feed.
- All feeds failing transport/structure or all-item normalization finish
  `rss_unavailable`. A structurally valid empty feed is not a failure; usable
  feeds whose articles are simply stale, irrelevant or already seen lead to
  `no_candidate`.
- Failure to read required history finishes `internal_failed` before Gemini;
  do not quietly assume empty history and repeat stories.
- Keep the existing atomic five-request reservation, unique slot keys, unique
  canonical URLs and delivery-state reconciliation.
- Different-minute runs can overlap and read the same diversity/history snapshot.
  This version does not add a distributed event lock: soft caps and semantic
  deduplication are best effort under that race, while existing quota and exact
  URL guards remain hard. Do not promise exactly-once semantic event delivery.

Emit one bounded structured diagnostic per feed and a selection summary per run.
Include trusted source ID, item/usable/rejected counts, fixed failure categories,
selected article ID when available, score components, classifier version and
diversity-fallback flag. Distinguish timeout, HTTP failure, invalid XML,
unsupported structure, invalid date and invalid item URL. Keep these details in
existing function logs rather than storing raw feeds or a new diagnostics table.

Never log response bodies, feed text, Telegram message text, secrets, request
headers or raw provider exceptions. Diagnostics must not call Gemini or Telegram.

## Verification and acceptance

Use deterministic fixtures and the existing Vitest, typecheck, pgTAP and repository
integration suites. Network access and live Gemini calls are not unit-test inputs.

Required coverage:

1. Sky BST/GMT, numeric offsets, UTC/ISO dates, missing/invalid/timezone-less dates
   and independence from machine timezone.
2. HTML with HTTP 200, non-feed XML, invalid XML, valid empty feeds, mixed valid/
   invalid items, timeouts, one feed failing and all feeds failing.
3. BBC tracking variants against current entries and legacy stored URLs (including
   old rows with refreshed feed dates), with meaningful nontracking query
   parameters preserved and no adjacent-path or wildcard false matches.
4. Hard age/relevance/seen filters, 72-hour and five-minute boundaries, no candidate
   behavior, deterministic scores and tie-breaks. A stronger Sky story must be
   able to beat a weaker BBC story.
5. Same-event cross-source grouping and direct official preference, alongside
   different stories about one player, rumors vs confirmations, media-watch
   reports, contradictory facts and nontransitive similarity cases.
6. Every diversity cap, combined violations, multi-entity counts, controlled
   fallback, two-feed fifth-draft case and sparse-feed days.
7. Vietnam midnight boundaries, pending/approved/rejected delivered history,
   failed/unsent exclusions, pagination and history-read failures.
8. No AI call for filtering/ranking, no more than one call per successful slot
   reservation, at most five reservations per logical Vietnam day under concurrent
   invocations, and unchanged duplicate-slot/exact-URL protections.
9. Existing Telegram callback, OFF/MANUAL, Open in X and delivery compensation
   tests remain green. New indexes preserve existing access restrictions.

Acceptance means these cases pass and the operator can see why a source was
unusable or a diversity cap relaxed. It does not mean five drafts are guaranteed,
all semantic duplicates are caught, or engagement has been proven to improve.

## Rollout and rollback

This document does not deploy anything. After implementation and verification:

1. Review the code diff and apply only the additive index migration.
2. Verify enabled feeds from the Supabase runtime without calling Gemini or
   sending Telegram messages, using a one-off operator check rather than a new
   public diagnostic endpoint.
3. Deploy the scheduled-pipeline function with the updated shared modules. No
   webhook registration, X secret or Telegram mode change is needed.
4. Inspect the next scheduled run, or run one explicitly authorized manual smoke
   test using the existing quota. Do not repeatedly trigger generation on timeout;
   inspect the existing run/delivery state first.
5. Inspect per-feed diagnostics and selection explanations over scheduled runs.
   Confirm diversity where candidates allow it; do not create extra runs to force
   a balanced sample.

Rollback redeploys the preceding pipeline revision. Additive indexes can remain;
keep all articles, drafts, quota records, settings and Telegram decisions intact.
Do not reset usage or replay sent drafts during rollback.
