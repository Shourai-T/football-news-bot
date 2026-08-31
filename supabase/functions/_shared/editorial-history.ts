import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.ts";
import type { SelectionHistory } from "./editorial-types.ts";
import type { Article } from "./domain-types.ts";
import {
  bbcArticleBase,
  canonicalizeUrl,
  escapeLikeLiteral,
} from "./url-normalization.ts";

const PAGE_SIZE = 100;
const HISTORY_WINDOW_MS = 72 * 60 * 60 * 1_000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const LEGACY_LOOKUP_CONCURRENCY = 4;

export function vietnamDayBounds(now: Date): { start: string; end: string } {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_scheduled_time");
  const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+07:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}
export async function readSelectionHistory(
  client: SupabaseClient<Database>,
  now: Date,
): Promise<SelectionHistory> {
  try {
    const { start, end } = vietnamDayBounds(now);
    const deliveredDrafts = await readDeliveredDrafts(client, start, end);
    const deliveredArticles = await readArticlesByIds(
      client,
      [...new Set(deliveredDrafts.map((draft) => draft.article_id))],
    );
    const deliveredById = new Map(
      deliveredArticles.map((row) => [row.id, toArticle(row)]),
    );
    const delivered = deliveredDrafts.map((draft) => {
      const article = deliveredById.get(draft.article_id);
      if (!article) throw new Error("missing_delivered_article");
      return article;
    });

    const selectedRows = await readRecentArticles(client, now);
    return { delivered, selected: selectedRows.map(toArticle) };
  } catch (error) {
    rethrowRepositoryError(error, "get_selection_history");
  }
}

export async function findLegacyBbcUrls(
  client: SupabaseClient<Database>,
  urls: readonly string[],
): Promise<Set<string>> {
  try {
    const requestedByBase = new Map<string, Set<string>>();
    for (const rawUrl of urls) {
      const normalized = canonicalizeUrl(rawUrl);
      const base = bbcArticleBase(normalized);
      if (!base) continue;
      const requested = requestedByBase.get(base) ?? new Set<string>();
      requested.add(normalized);
      requestedByBase.set(base, requested);
    }

    const matches = await mapWithConcurrency(
      [...requestedByBase.entries()],
      LEGACY_LOOKUP_CONCURRENCY,
      async ([base, requested]) => {
        const found = new Set<string>();
        for (let from = 0;; from += PAGE_SIZE) {
          const { data, error } = await client
            .from("articles")
            .select("id,canonical_url")
            .like("canonical_url", `${escapeLikeLiteral(base)}?%`)
            .order("id", { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
          if (error) throw error;
          for (const row of data) {
            const normalizedStored = canonicalizeUrl(row.canonical_url);
            if (requested.has(normalizedStored)) found.add(normalizedStored);
          }
          if (data.length < PAGE_SIZE) break;
        }
        return found;
      },
    );
    return new Set(matches.flatMap((match) => [...match]));
  } catch (error) {
    rethrowRepositoryError(error, "get_seen_urls");
  }
}

async function readDeliveredDrafts(
  client: SupabaseClient<Database>,
  start: string,
  end: string,
): Promise<Array<{ id: number; article_id: number }>> {
  const rows: Array<{ id: number; article_id: number }> = [];
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await client
      .from("drafts")
      .select("id,article_id")
      .not("telegram_message_id", "is", null)
      .in("status", ["pending", "approved", "rejected"])
      .gte("created_at", start)
      .lt("created_at", end)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

type ArticleRow = Database["public"]["Tables"]["articles"]["Row"];

async function readArticlesByIds(
  client: SupabaseClient<Database>,
  ids: readonly number[],
): Promise<ArticleRow[]> {
  const rows: ArticleRow[] = [];
  for (let from = 0; from < ids.length; from += PAGE_SIZE) {
    const { data, error } = await client
      .from("articles")
      .select("id,canonical_url,title,source_name,published_at,excerpt,eligible,created_at")
      .in("id", ids.slice(from, from + PAGE_SIZE))
      .order("id", { ascending: true });
    if (error) throw error;
    rows.push(...data);
  }
  return rows;
}

async function readRecentArticles(
  client: SupabaseClient<Database>,
  now: Date,
): Promise<ArticleRow[]> {
  const rows: ArticleRow[] = [];
  const oldest = new Date(now.getTime() - HISTORY_WINDOW_MS).toISOString();
  const newest = new Date(now.getTime() + FUTURE_TOLERANCE_MS).toISOString();
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await client
      .from("articles")
      .select("id,canonical_url,title,source_name,published_at,excerpt,eligible,created_at")
      .gte("published_at", oldest)
      .lte("published_at", newest)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

function toArticle(row: ArticleRow): Article {
  if (row.published_at === null) throw new Error("invalid_article_history");
  const publishedAt = new Date(row.published_at);
  if (!Number.isFinite(publishedAt.getTime())) throw new Error("invalid_article_history");
  return {
    title: row.title,
    excerpt: row.excerpt,
    sourceName: row.source_name,
    canonicalUrl: canonicalizeUrl(row.canonical_url),
    publishedAt,
    sourcePriority: 0,
    topicScore: 0,
  };
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  worker: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        output[index] = await worker(values[index]);
      }
    },
  ));
  return output;
}

function throwRepositoryError(operation: string): never {
  throw new Error(`repository_error:${operation}`);
}

function rethrowRepositoryError(error: unknown, operation: string): never {
  if (error instanceof Error && error.message === `repository_error:${operation}`) {
    throw error;
  }
  throwRepositoryError(operation);
}
