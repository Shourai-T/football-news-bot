import type { Article, DraftDecision, DraftStatus, RunOutcome } from "./types";

const MAX_QUERY_PARAMETERS = 100;

export async function beginRun(
  db: D1Database,
  slotKey: string,
  localDate: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO scheduled_runs (slot_key, local_date, outcome, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(slotKey, localDate, "running", now.toISOString())
    .run();

  return result.meta.changes === 1;
}

export async function getSeenUrls(
  db: D1Database,
  canonicalUrls: readonly string[],
): Promise<Set<string>> {
  const uniqueUrls = [...new Set(canonicalUrls)];
  if (uniqueUrls.length === 0) {
    return new Set();
  }

  const seenUrls = new Set<string>();
  for (let offset = 0; offset < uniqueUrls.length; offset += MAX_QUERY_PARAMETERS) {
    const chunk = uniqueUrls.slice(offset, offset + MAX_QUERY_PARAMETERS);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT canonical_url FROM articles WHERE canonical_url IN (${placeholders})`)
      .bind(...chunk)
      .all<{ canonical_url: string }>();
    for (const row of result.results) {
      seenUrls.add(row.canonical_url);
    }
  }

  return seenUrls;
}

export async function recordArticle(
  db: D1Database,
  article: Article,
  eligible: boolean,
  now: Date = new Date(),
): Promise<number | null> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO articles
        (canonical_url, title, source_name, published_at, excerpt, eligible, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      article.canonicalUrl,
      article.title,
      article.sourceName,
      article.publishedAt.toISOString(),
      article.excerpt,
      eligible ? 1 : 0,
      now.toISOString(),
    )
    .run();

  return result.meta.changes === 1 ? result.meta.last_row_id : null;
}

export async function reserveGeminiRequest(
  db: D1Database,
  slotKey: string,
  localDate: string,
): Promise<boolean> {
  await db
    .prepare("INSERT OR IGNORE INTO daily_usage (local_date, gemini_requests) VALUES (?, ?)")
    .bind(localDate, 0)
    .run();

  const quota = await db
    .prepare(
      "UPDATE daily_usage SET gemini_requests = gemini_requests + 1 WHERE local_date = ? AND gemini_requests < 5",
    )
    .bind(localDate)
    .run();
  if (quota.meta.changes !== 1) {
    return false;
  }

  const run = await db
    .prepare(
      "UPDATE scheduled_runs SET gemini_requests = 1 WHERE slot_key = ? AND local_date = ? AND gemini_requests = 0",
    )
    .bind(slotKey, localDate)
    .run();
  if (run.meta.changes === 1) {
    return true;
  }

  await db
    .prepare(
      "UPDATE daily_usage SET gemini_requests = gemini_requests - 1 WHERE local_date = ? AND gemini_requests > 0",
    )
    .bind(localDate)
    .run();
  return false;
}

export async function createDraft(
  db: D1Database,
  articleId: number,
  body: string,
  now: Date = new Date(),
): Promise<number> {
  const normalizedBody = body.trim();
  if (normalizedBody === "") {
    throw new Error("draft_body_empty");
  }

  const result = await db
    .prepare(
      "INSERT INTO drafts (article_id, body, status, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(articleId, normalizedBody, "pending", now.toISOString())
    .run();

  return result.meta.last_row_id;
}

export async function setDraftTelegramMessage(
  db: D1Database,
  draftId: number,
  telegramMessageId: number,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE drafts SET telegram_message_id = ? WHERE id = ?")
    .bind(telegramMessageId, draftId)
    .run();

  return result.meta.changes === 1;
}

export async function transitionDraft(
  db: D1Database,
  draftId: number,
  decision: DraftDecision,
  now: Date = new Date(),
): Promise<DraftStatus | null> {
  const result = await db
    .prepare("UPDATE drafts SET status = ?, decided_at = ? WHERE id = ? AND status = ?")
    .bind(decision, now.toISOString(), draftId, "pending")
    .run();
  if (result.meta.changes === 1) {
    return decision;
  }

  const existing = await db
    .prepare("SELECT status FROM drafts WHERE id = ?")
    .bind(draftId)
    .first<{ status: DraftStatus }>();
  return existing?.status ?? null;
}

export async function completeRun(
  db: D1Database,
  slotKey: string,
  outcome: Exclude<RunOutcome, "running">,
  errorSummary: string | null = null,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE scheduled_runs SET outcome = ?, error_summary = ?, completed_at = ? WHERE slot_key = ? AND outcome = ?",
    )
    .bind(outcome, errorSummary, now.toISOString(), slotKey, "running")
    .run();

  return result.meta.changes === 1;
}
