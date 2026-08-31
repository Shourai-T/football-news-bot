# Editorial Selection and RSS Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select a more varied set of eligible football stories while fixing RSS ingestion and preserving the existing five-request Gemini budget.

**Architecture:** Keep the Supabase scheduled pipeline. Add pure editorial classification, conservative event comparison and diversity-aware ranking; read narrowly scoped history from existing tables before selecting a candidate. Keep generation, quota reservation, Telegram delivery and manual X posting unchanged.

**Tech Stack:** Existing TypeScript, Supabase Edge Functions/Postgres, fast-xml-parser, Vitest and pgTAP. Use installed package versions and existing Deno import maps; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-31-editorial-selection-design.md` (approved 2026-08-31). Read the spec and this plan before execution.

**Execution status:** Not started. Checked items in the final coverage section
record plan review only; they do not claim code or tests have been completed.

## Global Constraints

- Five scheduled slots per Vietnam day, with at most five reserved Gemini requests across scheduled and manual runs. Failures can result in fewer drafts.
- One generation request only after selecting a final candidate; no AI ranking, embeddings, repair calls, or automatic regeneration in this change.
- Article age must be at most 72 hours relative to the run timestamp.
- Preserve the current five-minute future clock-skew tolerance; larger future dates are ineligible.
- Preserve the eight-second request timeout and independent feed fetching.
- Never relax age, URL deduplication, relevance or Gemini quota to fill a slot.
- Keep Telegram Approve/Reject, OFF/MANUAL and Open in X unchanged. AUTO remains locked. Do not edit the Gemini prompt.
- Only BBC and Sky are initially enabled. Do not enable ESPN, Liverpool or unverified official feeds.
- No feed archiving, backfill, deletion, new public endpoint, new secrets or new cron job.
- Retain existing exact-URL/slot/quota protections; semantic deduplication and diversity are best effort when different-minute runs overlap.
- Use Conventional Commits with `feat`, `fix`, `refactor` or `chore`; do not push, merge or deploy merely to complete this plan.
- Production reads/writes and live generation are not automated-test inputs. Any production smoke/deploy needs explicit rollout authorization.

## Workspace, baseline and execution order

Use the existing isolated worktree:
`/Users/anhtuan/Work/football-news-bot/.worktrees/feat-cloud-football-news-bot`.
Expected branch is `feat/cloud-football-news-bot`; spec commit is `2fe10ea`.
Check state again before edits, preserving unrelated changes:

```bash
git status --short --branch
git rev-parse --git-dir --git-common-dir
npm test
npm run typecheck
```

Do not create another worktree when already isolated. Baseline failures are not
permission to weaken tests. Use the debugging skill if verification fails.
Execute Tasks 1–8 in order. Each numbered step below is a separate action; repeat
the red/green cycle for each listed test group rather than writing all production
code before testing. Use `apply_patch` for edits. Code blocks are implementation
anchors and executable test examples, not instructions to modify files during
planning. Imports use `.ts` within runtime modules, matching this repository.

## File boundaries

| File | Responsibility |
| --- | --- |
| `_shared/feed-date.ts` (new) | Explicit timezone-aware feed date parsing |
| `_shared/url-normalization.ts` (new) | Shared canonical URL and legacy BBC equivalence |
| `_shared/feed-config.ts` | Enabled feeds and source policies, including disabled historical source mapping |
| `_shared/rss.ts` | Fetching, structure/item checks, bounded diagnostics |
| `_shared/editorial-types.ts` (new) | Interfaces shared by pure editorial modules and history repository |
| `_shared/editorial.ts` (new) | Entity aliases, classification, confirmed-source evidence and scoring |
| `_shared/event-dedup.ts` (new) | Conservative same-event comparison and deterministic grouping |
| `_shared/ranking.ts` | Hard eligibility and diversity-aware final choice |
| `_shared/editorial-history.ts` (new) | Paginated history and legacy URL reads using the existing Supabase client |
| `_shared/repository.ts` | Delegate editorial reads; retain all existing writes/RPC behavior |
| `_shared/pipeline.ts` | Wire history and selection; log safe decision metadata |
| `supabase/migrations/202608310001_editorial_history_indexes.sql` (new) | Add only the two history indexes |
| `test/supabase/*.test.ts` and `supabase/tests/database/0003_editorial_history.test.sql` | Unit, database and repository regression cases |
| `README.md` | Operator explanation and authorized rollout instructions |

All `_shared` paths above are under `supabase/functions/`. Do not restructure
unrelated webhook/generation code. `database.types.ts` needs no changes for
indexes alone. Update repository test doubles when the interface grows.

## Task 1: Parse dates explicitly and preserve legacy URL identity

**Files:** Create `supabase/functions/_shared/feed-date.ts`, `supabase/functions/_shared/url-normalization.ts`, `test/supabase/feed-date.test.ts`, `test/supabase/url-normalization.test.ts`; modify `supabase/functions/_shared/rss.ts` and its tests only to delegate existing normalization.

**Interfaces:**

```ts
export type FeedDatePolicy = "standard" | "sky-uk";
export function parsePublicationDate(value: string, policy: FeedDatePolicy): Date | null;
export function canonicalizeUrl(rawUrl: string): string;
export function isBbcArticleUrl(url: URL): boolean;
export function bbcArticleBase(rawUrl: string): string | null;
export function escapeLikeLiteral(value: string): string;
```

- [ ] **1. Write failing date and URL tests.** Use explicit expected UTC times:

```ts
import { expect, it } from "vitest";
import { parsePublicationDate } from "../../supabase/functions/_shared/feed-date";
import { canonicalizeUrl, escapeLikeLiteral } from "../../supabase/functions/_shared/url-normalization";

it.each([
  ["Mon, 31 Aug 2026 09:54:00 BST", "sky-uk", "2026-08-31T08:54:00.000Z"],
  ["Mon, 31 Aug 2026 09:54:00 GMT", "standard", "2026-08-31T09:54:00.000Z"],
  ["2026-08-31T09:54:00+07:00", "standard", "2026-08-31T02:54:00.000Z"],
  ["2026-08-31T09:54:00.123Z", "standard", "2026-08-31T09:54:00.123Z"],
] as const)("parses %s explicitly", (input, policy, expected) => {
  expect(parsePublicationDate(input, policy)?.toISOString()).toBe(expected);
});
it.each(["", "2026-08-31", "2026-08-31T09:54:00", "2026-02-30T12:00:00Z",
  "2026-08-31T25:00:00Z", "Mon, 31 Aug 2026 09:54:00 BST"])(
  "rejects ambiguous/invalid standard date %s", (input) => {
    expect(parsePublicationDate(input, "standard")).toBeNull();
  },
);
it("removes only known BBC tracking parameters", () => {
  expect(canonicalizeUrl("https://www.bbc.co.uk/sport/a?at_medium=RSS&at_campaign=rss&id=9#top"))
    .toBe("https://www.bbc.co.uk/sport/a?id=9");
  expect(canonicalizeUrl("https://other.test/a?at_medium=RSS&id=9"))
    .toBe("https://other.test/a?at_medium=RSS&id=9");
  expect(escapeLikeLiteral("/a_b%" )).toBe("/a\\_b\\%");
});
```

- [ ] **2. Run the focused tests, confirming failure from missing functionality.**

```bash
npx vitest run test/supabase/feed-date.test.ts test/supabase/url-normalization.test.ts
```

- [ ] **3. Implement explicit parsing and URL helpers.** Recognize only ISO with
  explicit `Z`/numeric offset and RFC-style English month dates with explicit
  GMT/UTC/numeric offset. Sky may translate a terminal BST token to `+0100`.
  Extract year/month/day/hour/minute/second/fraction/offset via anchored regexes;
  reject any unrecognized trailing data. Ignore an optional weekday label, as
  existing fixtures have inconsistent labels, but validate calendar fields.

```ts
// Inside feed-date.ts, after extracting numeric calendar fields:
function utcCalendar(year: number, month: number, day: number,
  hour: number, minute: number, second: number, millis: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 ||
      minute > 59 || second > 59 || hour < 0 || minute < 0 || second < 0) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) return null;
  return date.getTime();
}
// ISO capture grammar (fraction is milliseconds padded right to three digits):
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/;
const RFC = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+(GMT|UTC|[+-]\d{4})$/i;
// Offset hours must be 0..23, minutes 0..59. Result = calendar UTC - offset.
// Do not use new Date(rawFeedText) or local timezone APIs.
```

Move the existing canonicalizer into its own module; re-export it from `rss.ts`
to preserve imports. Retain the existing `utm_`, `fbclid`, `gclid` and fragment
removal; add BBC-only parameters. BBC host allowlist is exactly `bbc.co.uk`,
`www.bbc.co.uk`, `bbc.com`, `www.bbc.com`, not suffix matching. Require `/sport/`
article paths for the extra tracking rule.

```ts
export function bbcArticleBase(rawUrl: string): string | null {
  const url = new URL(rawUrl);
  return isBbcArticleUrl(url) ? `${url.origin}${url.pathname}` : null;
}
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
```

- [ ] **4. Verify both machine-timezone variants and existing RSS behavior.** Do
  not yet change Sky policy selection or enabled feeds; that is Task 2.

```bash
TZ=UTC npx vitest run test/supabase/feed-date.test.ts test/supabase/url-normalization.test.ts
TZ=Asia/Ho_Chi_Minh npx vitest run test/supabase/feed-date.test.ts test/supabase/url-normalization.test.ts
npx vitest run test/supabase/rss.test.ts
npm run typecheck
```

- [ ] **5. Review the diff and commit this tested parser/identity unit.**

```bash
git add supabase/functions/_shared/feed-date.ts supabase/functions/_shared/url-normalization.ts supabase/functions/_shared/rss.ts test/supabase/feed-date.test.ts test/supabase/url-normalization.test.ts test/supabase/rss.test.ts
git diff --cached --check
git commit -m "fix: normalize feed dates and bbc tracking urls"
```

## Task 2: Verify source configuration and expose feed failures

**Files:** Modify `supabase/functions/_shared/feed-config.ts`, `supabase/functions/_shared/rss.ts`, `test/supabase/feed-config.test.ts`, `test/supabase/rss.test.ts`.

**Interfaces:** Keep existing `FeedDefinition` and `Article` fields intact. Add
source policy types/lookup in `feed-config.ts`; `priority` remains compatibility
metadata only and will not drive final story ranking.

```ts
export interface SourcePolicy {
  id: string;
  name: string;
  kind: "publisher" | "official";
  credibility: number;
  datePolicy: "standard" | "sky-uk";
  articleHosts: readonly string[];
  directAnnouncementPaths: readonly string[];
}
export function resolveSource(name: string): SourcePolicy;
// rss.ts additions; preserve the existing fourth argument:
export interface FeedDiagnostic {
  sourceId: string;
  outcome: "ok" | "empty" | "failed";
  category: "none" | "timeout" | "network" | "http" | "invalid_xml" |
    "unsupported_structure" | "all_items_invalid";
  items: number;
  usable: number;
  invalidDate: number;
  invalidUrl: number;
  invalidContent: number;
}
// Add optional fifth argument to fetchFeedEntries:
// onDiagnostic?: (diagnostic: FeedDiagnostic) => void
```

- [ ] **1. Add failing tests for source policy, non-feed HTTP 200 and date loss.**

```ts
it("enables only BBC and Sky, with Sky-specific dates", () => {
  expect(VERIFIED_FEEDS.map((feed) => feed.name))
    .toEqual(["BBC Sport Football", "Sky Sports Football"]);
  expect(resolveSource("Sky Sports Football").datePolicy).toBe("sky-uk");
  expect(resolveSource("BBC Sport Football").credibility).toBe(15);
  expect(resolveSource("unrecognized").kind).toBe("publisher");
  expect(resolveSource("unrecognized").credibility).toBe(0);
});
it("reports HTML as a failure instead of a healthy empty feed", async () => {
  const failures: string[] = [];
  const diagnostics: FeedDiagnostic[] = [];
  await expect(fetchFeedEntries([VERIFIED_FEEDS[0]!], async () =>
    new Response("<html><body>Landing page</body></html>"), NOW,
    (name) => failures.push(name), (item) => diagnostics.push(item)))
    .resolves.toEqual([]);
  expect(failures).toEqual(["BBC Sport Football"]);
  expect(diagnostics[0]).toMatchObject({ outcome: "failed", category: "unsupported_structure" });
});
```

Add table-driven fixtures for `<feed/>` and `<rss><channel/></rss>` as valid
empty structures, `<anything/>` as unsupported, malformed XML, all-invalid dates,
one-valid/one-invalid item, unsafe links, fetch rejection and timeout. For the
Sky fixture use `Mon, 31 Aug 2026 09:54:00 BST` and assert one usable entry at
`2026-08-31T08:54:00.000Z`, not merely that the request succeeded.

- [ ] **2. Run `npx vitest run test/supabase/feed-config.test.ts test/supabase/rss.test.ts` and observe the intended failures.**

- [ ] **3. Implement source policy and root/item accounting.** Map BBC to `bbc`,
  Sky to `sky`; preserve historical Liverpool mapping to `liverpool` but give it
  no direct-announcement paths and do not include its feed in `VERIFIED_FEEDS`.
  Unknown sources use `unverified`, score 0 and no confirmation paths. All current
  policies have empty direct-announcement paths. Future paths require source
  verification, not runtime discovery. Wire the Task 1 parser using source policy.

```ts
// Structural detection must test property presence, not object truthiness:
const isRss = Object.hasOwn(document, "rss") &&
  Object.hasOwn(asRecord(document.rss) ?? {}, "channel");
const isAtom = Object.hasOwn(document, "feed");
if (!isRss && !isAtom) throw new Error("rss_unsupported_structure");
// Count items before normalization. One item gets one rejection category:
// missing title first, invalid URL second, invalid date third.
// items === 0 -> empty; items > 0 && usable === 0 -> all_items_invalid.
```

Refactor `fetchSingleFeed` to return entries and its diagnostic. In the existing
`Promise.allSettled` loop, issue exactly one diagnostic per configured feed and
retain the fourth-argument failure callback once per failed feed. Error mapping
must use known error names/categories only; never include an exception message
from `fetch`. A diagnostic callback must not turn a healthy fetch into a source
failure. Do not log feed titles, URLs, snippets or response bodies.

- [ ] **4. Run focused tests, then `npm test` and `npm run typecheck`.** Existing
  callers without the optional fifth argument must still compile and work.

- [ ] **5. Commit only the source/ingestion changes after reviewing the diff.**

```bash
git add supabase/functions/_shared/feed-config.ts supabase/functions/_shared/rss.ts test/supabase/feed-config.test.ts test/supabase/rss.test.ts
git diff --cached --check
git commit -m "fix: restore usable rss sources and report feed failures"
```

## Task 3: Classify stories and calculate transparent scores

**Files:** Create `supabase/functions/_shared/editorial-types.ts`, `supabase/functions/_shared/editorial.ts`, `test/supabase/editorial.test.ts`.

**Interfaces:** Consume existing `Article` and Task 2 `SourcePolicy`; export these
types and functions, used verbatim by Tasks 4–7:

```ts
export type EditorialType = "transfer" | "contract" | "injury" | "match" | "quote" | "stat" | "general";
export interface EventFeatures {
  key: string;
  materialNumbers: readonly string[];
}
export interface EditorialFeatures {
  sourceId: string;
  entities: readonly string[]; // player:/club: prefixes, canonical sorted IDs
  competitions: readonly string[];
  type: EditorialType;
  explicitDevelopment: boolean;
  directOfficial: boolean;
  credibility: number;
  titleTokens: readonly string[];
  event: EventFeatures | null;
}
export interface AnalyzedArticle { article: Article; features: EditorialFeatures; }
export interface ScoreParts { event: number; subjects: number; freshness: number; source: number; total: number; }
export interface SelectionHistory { delivered: readonly Article[]; selected: readonly Article[]; }
export interface SelectionResult {
  article: Article;
  sourceId: string;
  score: ScoreParts;
  diversityFallback: boolean;
  excess: number;
  classifierVersion: string;
}
// editorial.ts:
export const CLASSIFIER_VERSION = "editorial-v1";
export function normalizeWords(value: string): string;
export function analyzeArticle(article: Article, policy?: SourcePolicy): AnalyzedArticle;
export function scoreArticle(item: AnalyzedArticle, now: Date): ScoreParts;
```

- [ ] **1. Add failing tests for unique alias matches, false confirmations and scores.**

```ts
const NOW = new Date("2026-08-31T12:00:00Z");
const BASE: Article = {
  title: "Manchester United transfer news", excerpt: "", sourceName: "BBC Sport Football",
  canonicalUrl: "https://www.bbc.co.uk/sport/football/articles/example",
  publishedAt: NOW, sourcePriority: 100, topicScore: 2,
};
it("deduplicates club aliases and does not trust OFFICIAL in a title", () => {
  const analyzed = analyzeArticle({ ...BASE,
    title: "OFFICIAL: Man Utd Manchester United transfer update" });
  expect(analyzed.features.entities).toEqual(["club:manchester-united"]);
  expect(analyzed.features.directOfficial).toBe(false);
});
it("scores freshness separately from source priority", () => {
  const fresh = analyzeArticle(BASE);
  const old = analyzeArticle({ ...BASE, publishedAt: new Date(NOW.getTime() - 72 * 3_600_000) });
  expect(scoreArticle(fresh, NOW).freshness).toBe(30);
  expect(scoreArticle(old, NOW).freshness).toBe(0);
  expect(scoreArticle(fresh, NOW).source).toBe(15);
});
```

Use an explicit test-only `SourcePolicy` with kind `official`, host
`club.test` and path `/news/announcements/` to test an announcement; the production
registry remains unchanged. Require path/host match plus unambiguous first-party
confirmation, and assert false for `/news/media-watch/`, `reportedly`, `rumour`,
`rumor`, `according to`, `linked with`, a negated confirmation and a publisher.

- [ ] **2. Run `npx vitest run test/supabase/editorial.test.ts` and verify red.**

- [ ] **3. Implement pure classification and score functions.** Normalize NFKD,
  remove combining marks, lowercase, turn punctuation into spaces and collapse
  spaces. Recognize aliases with phrase boundaries, longest phrase first; return
  sets so repeated names cannot increase subject points.

Preserve every entity/competition in the existing `TOPIC_PATTERNS` in `rss.ts`.
Use kebab-case canonical IDs from full names. Add aliases only where identity is
unambiguous: Man Utd/Man United -> Manchester United, Man City -> Manchester City,
PSG -> Paris Saint-Germain, UCL -> Champions League, EPL -> Premier League, and
accent-insensitive Mbappe/Vinicius/Atletico forms. Do not classify `United` or
`City` alone. `entities` contains clubs and players; competition IDs are separate.

Classification uses explicit event verbs before presentation: completed/agreed
transfer, signed/extended contract, injury/return, match/result; quoted speech or
named statistic only when no clear event applies. Bare `transfer update` can have
type `transfer` but `explicitDevelopment=false`. Multiple conflicting event
types without a clear subject remain `general`. Normalize titles into unique
tokens, removing only this fixed set for event comparison:

```ts
const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "by", "with", "is", "are", "was", "were"]);
export function scoreArticle(item: AnalyzedArticle, now: Date): ScoreParts {
  const f = item.features;
  const event = f.directOfficial ? 30 : f.explicitDevelopment &&
    ["transfer", "contract", "injury", "match"].includes(f.type) ? 20 :
    ["quote", "stat"].includes(f.type) ? 10 : 0;
  const subjects = Number(f.entities.some((id) => id.startsWith("player:"))) * 10 +
    Number(f.entities.some((id) => id.startsWith("club:"))) * 5 +
    Number(f.competitions.length > 0) * 5;
  const age = Math.max(0, now.getTime() - item.article.publishedAt.getTime());
  const freshness = 30 * Math.max(0, 1 - age / (72 * 3_600_000));
  const source = f.directOfficial ? 20 : f.credibility;
  return { event, subjects, freshness, source, total: event + subjects + freshness + source };
}
```

Keep scores unrounded for sorting. A verified official source still needs direct
evidence for 20 credibility/30 event points. Ordinary source score comes from its
registry policy. `event` initially remains null until supported extractors are
added in Task 4; do not invent discriminator values from the generation prompt.

The initial direct-confirmation gate is intentionally narrow: exact allowed host,
allowed path prefix ending in `/`, an explicit development, and first-party text
`we confirm`, `we can confirm`, `the club confirms`, or `the club announces`.
Reject media-watch URLs and negation/third-party/rumor indicators before checking
that evidence. This gate can miss genuine announcements; do not expand it merely
to make a synthetic positive example pass. Use `The club confirms Harry Kane
joins Arsenal` as the positive test excerpt, and keep the article on the
test-only announcement path.

- [ ] **4. Run classifier tests, `npm test`, and `npm run typecheck`.** Confirm
  scores stay in 0–100, explicit player/club/competition categories contribute
  at most once, and future-skew clamping is tested separately from eligibility.

- [ ] **5. Commit the pure classification/scoring unit.**

```bash
git add supabase/functions/_shared/editorial-types.ts supabase/functions/_shared/editorial.ts test/supabase/editorial.test.ts
git diff --cached --check
git commit -m "feat: classify football stories and score editorial value"
```

## Task 4: Compare and group duplicate events conservatively

**Files:** Create `supabase/functions/_shared/event-dedup.ts`, `test/supabase/event-dedup.test.ts`; extend `supabase/functions/_shared/editorial.ts` and `test/supabase/editorial.test.ts` for supported event extraction.

**Interfaces:** Consume `AnalyzedArticle`, `EditorialFeatures`, `EventFeatures`
and `scoreArticle` from Task 3. Add:

```ts
export function sameEvent(left: AnalyzedArticle, right: AnalyzedArticle): boolean;
export function groupCurrentEvents(items: readonly AnalyzedArticle[], now: Date): AnalyzedArticle[];
// Private in editorial.ts; event-dedup.ts must not be imported by editorial.ts:
function extractEventFeatures(article: Article, features: Omit<EditorialFeatures, "event">): EventFeatures | null;
```

- [ ] **1. Write positive and negative duplicate tests.** Start with a concrete
  transfer discriminator and a changed destination, not just two similar names:

```ts
const NOW = new Date("2026-08-31T12:00:00Z");
function story(title: string, path: string, sourceName = "BBC Sport Football"): Article {
  return { title, excerpt: "", sourceName, canonicalUrl: `https://news.test/${path}`,
    publishedAt: NOW, sourcePriority: 100, topicScore: 2 };
}
it("collapses the same completed transfer but not another destination", () => {
  const a = analyzeArticle(story("Harry Kane joins Arsenal", "a"));
  const b = analyzeArticle(story("Harry Kane joins Arsenal", "b", "Sky Sports Football"));
  const c = analyzeArticle(story("Harry Kane joins Chelsea", "c"));
  expect(sameEvent(a, b)).toBe(true);
  expect(sameEvent(a, c)).toBe(false);
  expect(groupCurrentEvents([c, b, a], NOW)).toHaveLength(2);
});
it("does not merge unrelated stories mentioning Ronaldo", () => {
  const a = analyzeArticle(story("Ronaldo suffers injury", "a"));
  const b = analyzeArticle(story("Ronaldo discusses retirement", "b"));
  expect(sameEvent(a, b)).toBe(false);
});
```

Add fixtures for rumor versus completion, contract extension versus termination,
injury versus return, conflicting numeric facts, match dates/opponents, a quote
about the same player but on another subject, threshold 0.80 boundaries, same
canonical URL, absent discriminators, official representative preference and a
nontransitive A/B/C similarity chain. Reverse input order and assert the same
representatives. For direct-official grouping use explicitly constructed analyzed
fixtures or the Task 3 test-only policy, never a production registry bypass.

- [ ] **2. Run `npx vitest run test/supabase/event-dedup.test.ts test/supabase/editorial.test.ts` and verify red.**

- [ ] **3. Extract only evidence-complete keys and implement grouping.** Event
  extraction belongs in `editorial.ts`, using its alias tables, so dependencies
  remain one-way. The key is `JSON.stringify` of an ordered tuple, never a broad
  player-only hash. Use these exact completeness rules:

| Type | Required key components |
| --- | --- |
| transfer | recognized player, explicit destination club, stage `rumor`/`agreed`/`completed`; verbs `linked with`, `agrees to join`, `joins`/`signs for` are separate stages |
| contract | recognized subject, explicit `extends`/`terminates` action, stated contract end year/date |
| injury | recognized subject, explicit injury/return action, stated incident/date discriminator |
| match | two recognized opponent clubs, explicitly stated match date, result/stage |
| quote | recognized speaker, complete quoted span of at least eight normalized words |
| stat | recognized subject, named metric, stated competition/period and numeric value |
| general | no event key; URL deduplication only |

Missing or ambiguous components yield null. No relative date inference from
fetch time. If positive/negative fixture pairs cannot demonstrate a safe extractor
for a type, keep that type null and document its URL-only behavior in README.
Recognize numbers from title and excerpt, sort/deduplicate their normalized tokens,
and require equality as a conservative conflict check. Keep negation/rumor/stage
words out of the stop-word list.

```ts
export function sameEvent(a: AnalyzedArticle, b: AnalyzedArticle): boolean {
  if (canonicalizeUrl(a.article.canonicalUrl) === canonicalizeUrl(b.article.canonicalUrl)) return true;
  const x = a.features, y = b.features;
  if (x.type !== y.type || x.type === "general" || !x.event || !y.event) return false;
  if (JSON.stringify(x.entities) !== JSON.stringify(y.entities) ||
      x.event.key !== y.event.key ||
      JSON.stringify(x.event.materialNumbers) !== JSON.stringify(y.event.materialNumbers)) return false;
  const left = new Set(x.titleTokens), right = new Set(y.titleTokens);
  if (!left.size || !right.size) return false;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / new Set([...left, ...right]).size >= 0.80;
}
```

`groupCurrentEvents` sorts a copy by `directOfficial` descending, total score
descending, publication time descending, then URL ascending (plain code-point
comparison). Iterate in that order; place an item in the first group for which
`group.every(member => sameEvent(member, item))`, otherwise create a group. Return
each group's first element. This keeps official preference inside an event only;
it does not give every official article unconditional priority across events.

- [ ] **4. Run focused tests, `npm test`, and `npm run typecheck`.** Check empty
  inputs, input immutability and no external calls/import-time side effects.

- [ ] **5. Review and commit the event comparator separately from selection.**

```bash
git add supabase/functions/_shared/editorial.ts supabase/functions/_shared/event-dedup.ts test/supabase/editorial.test.ts test/supabase/event-dedup.test.ts
git diff --cached --check
git commit -m "feat: deduplicate confidently matching football events"
```

## Task 5: Select the best eligible story using daily diversity

**Files:** Modify `supabase/functions/_shared/ranking.ts`; create `test/supabase/editorial-ranking.test.ts`.

**Interfaces:** Keep the legacy export temporarily so the existing pipeline stays
compilable until Task 7. The new selector consumes Task 3 types and Task 4 helpers:

```ts
export function selectEditorialCandidate(
  entries: readonly Article[], seenUrls: ReadonlySet<string>, now: Date,
  history: SelectionHistory,
): SelectionResult | null;
```

- [ ] **1. Add failing ranking scenarios, starting with source diversity.**

```ts
const NOW = new Date("2026-08-31T12:00:00Z");
function item(sourceName: string, path: string, title: string): Article {
  return { sourceName, canonicalUrl: `https://news.test/${path}`, title, excerpt: "",
    publishedAt: NOW, sourcePriority: sourceName.startsWith("BBC") ? 100 : 80, topicScore: 1 };
}
it("uses Sky after two BBC deliveries when an eligible alternative exists", () => {
  const bbc = item("BBC Sport Football", "new-bbc", "Harry Kane joins Arsenal");
  const sky = item("Sky Sports Football", "new-sky", 'Messi says: "I still enjoy playing football every single day"');
  const delivered = [item("BBC Sport Football", "old-a", "Liverpool training update"),
    item("BBC Sport Football", "old-b", "Chelsea training update")];
  const result = selectEditorialCandidate([bbc, sky], new Set(), NOW, { delivered, selected: [] });
  expect(result?.article.canonicalUrl).toBe(sky.canonicalUrl);
  expect(result?.diversityFallback).toBe(false);
});
it("relaxes only diversity when no compliant source remains", () => {
  const candidate = item("BBC Sport Football", "new", "Harry Kane joins Arsenal");
  const result = selectEditorialCandidate([candidate], new Set(), NOW, {
    delivered: [item("BBC Sport Football", "a", "Liverpool training update"),
      item("BBC Sport Football", "b", "Chelsea training update")], selected: [],
  });
  expect(result).toMatchObject({ diversityFallback: true, excess: 1 });
});
```

Add cases for each entity/type cap, multi-entity counts, competition exclusion,
least-excess ordering before score, score/time/URL ties, five slots using two
sources, empty feeds, all-stale/irrelevant/seen entries, boundaries at 72h/5min,
invalid timestamps/HTTPS/title, stronger Sky beating weaker BBC with no cap
pressure, previous selected events, and a later distinct development.

- [ ] **2. Run `npx vitest run test/supabase/editorial-ranking.test.ts` and verify red.**

- [ ] **3. Implement hard filtering, grouping and counts as pure functions.**
  Normalize all candidate URLs and seen URLs before comparison; catch invalid URLs
  as ineligible input rather than throwing out valid siblings. Preserve original
  Article object identity when its canonical URL is already normalized (pipeline
  test doubles currently rely on reference identity).

```ts
function dimensions(item: AnalyzedArticle): string[] {
  return [`source:${item.features.sourceId}`, `type:${item.features.type}`,
    ...item.features.entities.map((entity) => `entity:${entity}`)];
}
function countDelivered(items: readonly AnalyzedArticle[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) for (const key of new Set(dimensions(item))) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function excessFor(item: AnalyzedArticle, counts: ReadonlyMap<string, number>): number {
  return dimensions(item).reduce((sum, key) =>
    sum + Math.max(0, (counts.get(key) ?? 0) + 1 - 2), 0);
}
```

Analyze hard-eligible candidates and history with the same classifier. Remove
candidates matching any recent `history.selected` event, then collapse current
groups. Compute scores and excess. If any excess-zero candidates exist, discard
the positive-excess candidates for this run. Otherwise choose minimum excess.
Within that set sort by total score descending, timestamp descending, URL
ascending. Return `SelectionResult` with `CLASSIFIER_VERSION`; null only when
no hard-eligible representative remains. Do not alter `history` or `entries`.

Filtering invariants: finite `now` and publication time, nonempty title, HTTPS URL,
`topicScore > 0`, age <= 72h and future offset <= 5min. Read history classification
without filtering delivered rows by article age: an older article delivered today
still contributed to today's repetition. Selected-event history is already
window-bounded by the repository, but enforce its publication window in the pure
selector too so direct callers cannot suppress stories with stale history.

- [ ] **4. Run both ranking test files, classifier/event tests, all unit tests and typecheck.**

```bash
npx vitest run test/supabase/ranking.test.ts test/supabase/editorial-ranking.test.ts test/supabase/event-dedup.test.ts test/supabase/editorial.test.ts
npm test
npm run typecheck
```

- [ ] **5. Review and commit the new selector; do not activate it in production yet.**

```bash
git add supabase/functions/_shared/ranking.ts test/supabase/editorial-ranking.test.ts
git diff --cached --check
git commit -m "feat: rank drafts with soft daily diversity limits"
```

## Task 6: Read delivery/event history and match legacy BBC URLs

**Files:** Create `supabase/functions/_shared/editorial-history.ts`, `test/supabase/editorial-history.test.ts`, `supabase/migrations/202608310001_editorial_history_indexes.sql`, `supabase/tests/database/0003_editorial_history.test.sql`; modify `supabase/functions/_shared/repository.ts`, `test/supabase/repository.integration.test.ts`, `test/supabase/pipeline.test.ts`, `test/supabase/scheduled-handler.test.ts`, `test/supabase/telegram-webhook.test.ts`.

**Interfaces:**

```ts
// editorial-history.ts:
export function vietnamDayBounds(now: Date): { start: string; end: string };
export function readSelectionHistory(client: SupabaseClient<Database>, now: Date): Promise<SelectionHistory>;
export function findLegacyBbcUrls(client: SupabaseClient<Database>, urls: readonly string[]): Promise<Set<string>>;
// Required new BotRepository member, delegated by SupabaseBotRepository:
getSelectionHistory(now: Date): Promise<SelectionHistory>;
```

- [ ] **1. Add failing database/history/integration cases.** Example delivered-history
  test goes inside the existing repository integration suite so its local cleanup
  and initialized repository are reused:

```ts
it("counts delivered pending/approved/rejected drafts, excluding unsent and failed", async () => {
  for (const [index, status] of ["pending", "approved", "rejected", "failed", "unsent"].entries()) {
    const articleId = await repository.recordArticle({ ...BASE_ARTICLE,
      canonicalUrl: `https://example.com/history/${index}` }, true, NOW);
    const draftId = await repository.createDraft(articleId!, "Draft", NOW);
    if (["pending", "approved", "rejected"].includes(status)) {
      await repository.setDraftTelegramMessage(draftId, 100 + index);
    }
    if (status === "approved" || status === "rejected") {
      await repository.transitionDraft(draftId, status, NOW);
    }
    if (status === "failed") await repository.markDraftFailed(draftId);
  }
  const history = await repository.getSelectionHistory(NOW);
  expect(history.delivered).toHaveLength(3);
  expect(history.selected).toHaveLength(5);
});
it("recognizes a legacy BBC URL outside the recent history window", async () => {
  await repository.recordArticle({ ...BASE_ARTICLE,
    canonicalUrl: "https://www.bbc.co.uk/sport/football/articles/old?at_medium=RSS&at_campaign=rss",
    publishedAt: new Date("2026-01-01T00:00:00Z") }, true, NOW);
  await expect(repository.getSeenUrls([
    "https://www.bbc.co.uk/sport/football/articles/old",
    "https://www.bbc.co.uk/sport/football/articles/old-next",
  ])).resolves.toEqual(new Set(["https://www.bbc.co.uk/sport/football/articles/old"]));
});
```

Add more than 100 relevant rows to prove pagination for both history collections;
also test exactly 100 and zero rows. Test day start included/day end excluded at
17:00 UTC, age window edges, logical start day for a run crossing midnight, missing
joined rows, invalid stored dates and redacted read errors. Test BBC query
parameters with different meaningful `id` values, `%`/`_` path characters,
adjacent paths, non-BBC hosts, old tracking order and refreshed publication dates.
Mock the Supabase query builder only for fault injection/escaping; use the real
local database for join/LIKE/pagination semantics.

Create this pgTAP file before the migration:

```sql
begin;
select plan(4);
select has_index('public', 'articles', 'articles_published_at_idx', 'article history index exists');
select has_index('public', 'drafts', 'drafts_delivered_created_at_idx', 'delivery history index exists');
select ok(not has_table_privilege('anon', 'public.articles', 'SELECT'), 'articles remain private');
select ok(not has_table_privilege('authenticated', 'public.drafts', 'SELECT'), 'drafts remain private');
select * from finish();
rollback;
```

- [ ] **2. Run unit checks and local database tests to observe failures.** First
  confirm Docker/local Supabase are available and this is the disposable local
  test stack. Use `npm run supabase:start` only if needed. Never point integration
  tests at a linked/cloud URL: the existing test setup deletes local fixture rows.
  The wrapper obtains localhost credentials from CLI status without printing them.

```bash
npx vitest run test/supabase/editorial-history.test.ts
npm run test:db
npm run test:integration
```

- [ ] **3. Implement bounded reads and the additive indexes.** The migration is
  exactly these two indexes, no new functions/tables/privileges:

```sql
create index articles_published_at_idx on public.articles(published_at);
create index drafts_delivered_created_at_idx on public.drafts(created_at)
  where telegram_message_id is not null and status in ('pending', 'approved', 'rejected');
```

Use offset pagination with page size 100 and stable `id` ordering. Stop on a short
page, not an arbitrary total-row cap. Concurrent insertions can alter a snapshot;
that is consistent with the spec's best-effort diversity, not a strict lock.

```ts
export function vietnamDayBounds(now: Date): { start: string; end: string } {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_scheduled_time");
  const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+07:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}
// Query each delivery page, with offset starting at zero:
const { start, end } = vietnamDayBounds(now);
const deliveryQuery = client.from("drafts")
  .select("id,articles!inner(canonical_url,title,excerpt,source_name,published_at)")
  .not("telegram_message_id", "is", null)
  .in("status", ["pending", "approved", "rejected"])
  .gte("created_at", start).lt("created_at", end)
  .order("id", { ascending: true }).range(offset, offset + 99);
// Selected-event pages use articles directly:
const selectedQuery = client.from("articles")
  .select("id,canonical_url,title,excerpt,source_name,published_at")
  .gte("published_at", new Date(now.getTime() - 72 * 3_600_000).toISOString())
  .lte("published_at", new Date(now.getTime() + 5 * 60_000).toISOString())
  .order("id", { ascending: true }).range(offset, offset + 99);
```

Map required stored fields to `Article`; validate joined object/date shape and
throw `repository_error:get_selection_history` on corrupt data or provider error.
History-only `sourcePriority` and `topicScore` are zero because historical rows
are not re-entered as candidate input. Classification uses title/excerpt/policy,
not those two legacy numbers. Canonicalize stored URLs before returning history.

Keep the existing exact batched URL query in `getSeenUrls`. Add legacy BBC matches
for unique candidate base paths using a maximum of four concurrent base lookups:

```ts
// base is produced only by bbcArticleBase; page the stored query variants:
const query = client.from("articles").select("id,canonical_url")
  .like("canonical_url", `${escapeLikeLiteral(base)}?%`)
  .order("id", { ascending: true }).range(offset, offset + 99);
// Existing exact lookup covers the bare base URL and exact requested URLs.
// For every row, canonicalize and compare equality against the normalized
// requested URL set for this exact base. Return requested normalized URLs.
```

Use four async workers sharing an in-memory next-base index, each processing one
base's pages before taking another. This bounds network concurrency without a
new dependency. SQL wildcard escaping must be tested against real Postgres.
Only mark equal normalized URLs seen; never treat any prefix match as identity.
No age filter and no full-table download. Any lookup failure fails closed before
generation, with `repository_error:get_seen_urls` and no raw provider text.

Delegate `getSelectionHistory` from the repository class. Add its implementation
to `PipelineRepository` in `pipeline.test.ts` (default empty history) and
`HandlerRepository` in `scheduled-handler.test.ts` (reject if unexpectedly called).
Also update `MemoryRepository` in `telegram-webhook.test.ts` with a rejecting
implementation: callbacks must never request selection history. Search for other
`implements BotRepository` before committing and update every test double without
making the method optional.

- [ ] **4. Apply the migration only to local Supabase, then rerun tests.** Do not
  use `db reset` or `db push --linked` as a shortcut.

```bash
npx supabase migration up --local
npm run test:db
npm run test:integration
npm test
npm run typecheck
```

- [ ] **5. Review and commit history access with its migration/tests.**

```bash
git add supabase/functions/_shared/editorial-history.ts supabase/functions/_shared/repository.ts supabase/migrations/202608310001_editorial_history_indexes.sql supabase/tests/database/0003_editorial_history.test.sql test/supabase/editorial-history.test.ts test/supabase/repository.integration.test.ts test/supabase/pipeline.test.ts test/supabase/scheduled-handler.test.ts test/supabase/telegram-webhook.test.ts
git diff --cached --check
git commit -m "feat: read editorial history and match legacy bbc urls"
```

## Task 7: Wire editorial selection and safe diagnostics into the pipeline

**Files:** Modify `supabase/functions/_shared/pipeline.ts`, `supabase/functions/_shared/ranking.ts`, `supabase/functions/scheduled-pipeline/handler.ts`, `test/supabase/pipeline.test.ts`, `test/supabase/ranking.test.ts`, `test/supabase/scheduled-handler.test.ts`.

**Interfaces:** `PipelineDependencies.selectCandidate` now has type
`typeof selectEditorialCandidate`. Fetcher's existing signature plus the optional
Task 2 diagnostic callback is retained. `runScheduledPipeline` and HTTP response
shapes do not change. Task 6 `getSelectionHistory(now)` is required, not optional.

- [ ] **1. Add failing orchestration and failure tests before wiring.** In the
  existing `setup()`, return a proper `SelectionResult` around the same `ARTICLE`
  instance rather than an Article directly. Keep null-based tests intact.

```ts
const score = { event: 20, subjects: 5, freshness: 30, source: 15, total: 70 };
const selectCandidate = vi.fn<PipelineDependencies["selectCandidate"]>(() => ({
  article: ARTICLE, sourceId: "bbc", score, diversityFallback: false,
  excess: 0, classifierVersion: "editorial-v1",
}));
// PipelineRepository additions, with existing methods retained:
history: SelectionHistory = { delivered: [], selected: [] };
historyError = false;
async getSelectionHistory(_now: Date): Promise<SelectionHistory> {
  if (this.historyError) throw new Error("repository_error:get_selection_history");
  return this.history;
}
```

Add these tests using the existing setup helper:

```ts
it("does not spend quota or send messages when history cannot be read", async () => {
  const context = setup();
  context.repository.historyError = true;
  expect(await runScheduledPipeline(context.dependencies, NOW)).toBe("internal_failed");
  expect(context.selectCandidate).not.toHaveBeenCalled();
  expect(context.repository.reservations).toHaveLength(0);
  expect(context.generate).not.toHaveBeenCalled();
  expect(context.telegramFetch).not.toHaveBeenCalled();
});
it("passes delivery and attempt history into the pure selector", async () => {
  const context = setup();
  context.repository.history = { delivered: [ARTICLE], selected: [ARTICLE] };
  context.selectCandidate.mockReturnValue(null);
  await runScheduledPipeline(context.dependencies, NOW);
  expect(context.selectCandidate).toHaveBeenCalledWith(
    [ARTICLE], new Set(), NOW, context.repository.history);
  expect(context.generate).not.toHaveBeenCalled();
});
```

Add a true in-memory pipeline test using the real new selector and a mocked RSS
fetch, not only a mocked candidate. Feed two BBC deliveries plus a diverse Sky
quote, assert Gemini receives the chosen Sky Article once, and assert quota
reservation precedes that one generate call. Add all-feed failure, valid-empty,
only-invalid-dates, duplicate-slot and exact-URL claim collision cases asserting
zero generation. Keep existing Gemini/Telegram/persistence failure tests unchanged.

- [ ] **2. Run `npx vitest run test/supabase/pipeline.test.ts test/supabase/scheduled-handler.test.ts` and confirm failing new assertions.**

- [ ] **3. Wire only the pre-generation portion of the pipeline.** After the
  existing all-feed-failure gate, read seen URLs and required history, then select:

```ts
const [seenUrls, history] = await Promise.all([
  dependencies.repository.getSeenUrls(entries.map((entry) => entry.canonicalUrl)),
  dependencies.repository.getSelectionHistory(scheduledAt),
]);
const selection = dependencies.selectCandidate(entries, seenUrls, scheduledAt, history);
if (selection === null) {
  logEvent("editorial_selection", { slotKey, outcome: "no_candidate" });
  return await complete(dependencies.repository, slotKey, "no_candidate", null, scheduledAt);
}
const candidate = selection.article;
// Preserve the existing recordArticle, null-claim check, reserve, generation,
// createDraft, delivery and persistence/compensation sequence below this point.
```

Pass a fifth callback to `fetchFeeds` that logs scalar fields from
`FeedDiagnostic` with `slotKey`. Issue one selection log after article claim
(or a no-candidate log before returning), using only explicitly selected fields:

```ts
logEvent("editorial_selection", {
  slotKey, articleId, sourceId: selection.sourceId,
  classifierVersion: selection.classifierVersion,
  scoreEvent: selection.score.event, scoreSubjects: selection.score.subjects,
  scoreFreshness: selection.score.freshness, scoreSource: selection.score.source,
  scoreTotal: selection.score.total, excess: selection.excess,
  diversityFallback: Number(selection.diversityFallback),
});
```

Do not spread `Article` or provider objects into a log. Existing `logEvent`
accepts string/number fields, so encode flags as 0/1 instead of broadening it to
arbitrary objects. A selection failure before a claim can log fixed outcome only.
Do not make diagnostic logging change a completed delivery into a failure.

Update the handler's import/wiring to `selectEditorialCandidate`. Remove the old
`selectBestCandidate` function and its source-priority test once every caller is
migrated. Preserve the old hard-eligibility regression under the new signature,
accessing `result?.article.canonicalUrl`. No wrapper that silently substitutes
empty history is allowed. Search to prove no old selector callers remain.

- [ ] **4. Verify logs and all regression suites.** Capture `console.error` in
  tests, include sentinels in feed body/title/exception/token fields and assert
  they never appear in serialized logs. Assert feed counters and numeric fallback
  flag do appear. Use mocks so log tests do not call external providers.

```bash
rg -n 'selectBestCandidate' supabase/functions test/supabase
npm test
npm run typecheck
npm run test:db
npm run test:integration
```

The `rg` command is expected to return no matches (exit 1). Tests/typecheck must
exit 0. Existing quota-concurrency integration test must still admit only five
of six simultaneous reservations. Do not change or refund that quota behavior.

- [ ] **5. Review the integrated change and commit.**

```bash
git add supabase/functions/_shared/pipeline.ts supabase/functions/_shared/ranking.ts supabase/functions/scheduled-pipeline/handler.ts test/supabase/pipeline.test.ts test/supabase/ranking.test.ts test/supabase/scheduled-handler.test.ts
git diff --cached --check
git commit -m "feat: select diverse drafts before gemini generation"
```

## Task 8: Document operation, verify the complete change and hand off

**Files:** Modify `README.md`, `test/supabase/runbook-security.test.ts`; update
this plan's checkboxes only after each corresponding verification is complete.

**Interfaces:** No runtime interfaces added. Documentation describes existing
authenticated operation, new diagnostic categories and additive migration only.

- [ ] **1. Add a documentation regression before changing README.** Extend the
  existing raw-import runbook tests with these assertions:

```ts
it("documents editorial fallback without promising five posts", () => {
  expect(readme).toContain("BBC / Sky Sports RSS");
  expect(readme).toContain("diversityFallback");
  expect(readme).toContain("does not confirm publication on X");
  expect(readme).not.toContain("BBC / Sky Sports / Liverpool FC RSS");
});
```

- [ ] **2. Run `npx vitest run test/supabase/runbook-security.test.ts` and verify the expected failure.**

- [ ] **3. Update README with this operator-facing content, preserving all other security instructions.**

```markdown
### Editorial selection

The pipeline reads BBC / Sky Sports RSS and scores eligible stories without an
additional Gemini call. Sky timestamps are parsed with their explicit timezone.
Liverpool and ESPN are not enabled in this release.

It prefers no more than two delivered drafts per source, recognized club/player
or editorial type per Vietnam day. When all eligible choices exceed a cap, the
least repetitive choice wins and logs `diversityFallback: 1`. Two sources require
that fallback for any fifth draft. Age, relevance, deduplication and the five-call
Gemini quota are never relaxed. Five drafts are a target, not a guarantee.

Daily diversity counts confirmed Telegram deliveries, including pending,
approved and rejected drafts, using the run's Vietnam start day.
Approval does not confirm publication on X.
The user still opens X and presses Post manually.

Feed diagnostics distinguish invalid structure, date loss, HTTP errors and
timeouts. Inspect `rss_feed` and `editorial_selection` events by slot key. These
logs contain counts and score components, not story text or secrets. Supported
same-event comparisons are conservative; missing facts mean URL-only matching.
Different-minute concurrent runs can exceed soft caps or miss semantic duplicates.
```

Ensure Task 7 names the feed log event `rss_feed`, matching this runbook. List the
event types actually supported by passing extractors; do not claim every type
has semantic matching if one remains null. Add a rollout subsection with the
following **operator steps, not commands to execute without authorization**:

1. Review local evidence and confirm target Supabase project. Apply only
   `202608310001_editorial_history_indexes.sql` after reviewing pending migrations.
2. Verify RSS from the Supabase runtime with a one-off read-only operator check,
   not a public endpoint and not a Gemini/Telegram invocation. Mac results alone
   do not satisfy this check. If no such runtime check is available, report the
   release gate as incomplete rather than claiming it was verified.
3. Deploy only `scheduled-pipeline` with updated shared modules. No webhook
   registration, secret rotation or posting-mode change is necessary.
4. Observe the next existing cron run, or obtain authorization for exactly one
   manual smoke run that consumes the existing quota. Inspect the recorded run
   after timeout before considering any retry.
5. Roll back by redeploying the previous pipeline revision; leave indexes and
   all history/quota/settings intact. Never reset usage to make a test succeed.

- [ ] **4. Run final verification freshly; capture counts from actual output.**

```bash
npm test
npm run typecheck
npm run test:db
npm run test:integration
npx supabase db lint --local
git diff --check
git status --short --branch
```

If local services are unavailable, report which suites did not run; do not reuse
historical counts. Integration tests must run only via the local wrapper. If
this work started local Supabase, stop that same local stack afterwards using
the existing stop command without deleting backups; leave pre-existing user
services alone. Do not infer authorization to stop Docker itself.

Use the requesting-code-review and verification-before-completion skills before
claiming implementation complete. Apply their review requirements to the actual
diff; distinguish reviewer findings from accepted limitations in the spec.

- [ ] **5. Commit the verified documentation and hand off the feature.**

```bash
git add README.md test/supabase/runbook-security.test.ts docs/superpowers/plans/2026-08-31-editorial-selection.md
git diff --cached --check
git commit -m "chore: document editorial selection and rollout checks"
git status --short --branch
```

Report actual test results, commits and whether production deployment is still
pending. Do not push, merge, apply cloud migrations, send Telegram messages or
spend a Gemini request just because local implementation is finished.

## Spec coverage and self-review checklist

- [x] Date/structure errors and source allowlist: Tasks 1–2.
- [x] BBC URL normalization and old rows independent of age: Tasks 1 and 6.
- [x] Classification, score bounds and direct official evidence: Task 3.
- [x] Conservative event comparison, conflicts and representative selection: Task 4.
- [x] Hard eligibility, daily caps, least-excess fallback and two-source limits: Task 5.
- [x] Delivered-vs-attempt history, Vietnam boundaries, pagination and indexes: Task 6.
- [x] No additional Gemini calls, failure gates, safe logs and unchanged delivery: Task 7.
- [x] Callback/manual-X/quota concurrency regressions and rollout boundaries: Tasks 7–8.
- [x] Every new signature in downstream tasks matches the interfaces above.
- [x] All new helper files are accounted for in the file map and commit targets.

## Execution handoff

Planning does not implement or deploy this feature. Recommended execution here
is inline, task by task with checkpoints, because the tasks share interfaces and
the user has been working in this session. Use `superpowers:executing-plans` if
that approach is approved. If the user chooses delegated execution instead,
follow `superpowers:subagent-driven-development`; do not spawn agents during
plan writing or self-review.
