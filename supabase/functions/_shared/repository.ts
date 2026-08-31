import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.ts";
import type {
  Article,
  DraftDecision,
  DraftStatus,
  StoredDraft,
  TerminalRunOutcome,
  XPostingMode,
} from "./domain-types.ts";
import type { SelectionHistory } from "./editorial-types.ts";
import { findLegacyBbcUrls, readSelectionHistory } from "./editorial-history.ts";

const URL_LOOKUP_BATCH_SIZE = 100;
const URL_LOOKUP_MAX_ENCODED_LENGTH = 1_800;

export interface BotRepository {
  beginRun(slotKey: string, localDate: string, now: Date): Promise<boolean>;
  getSeenUrls(canonicalUrls: readonly string[]): Promise<Set<string>>;
  getSelectionHistory(now: Date): Promise<SelectionHistory>;
  recordArticle(
    article: Article,
    eligible: boolean,
    now: Date,
  ): Promise<number | null>;
  reserveGeminiRequest(slotKey: string, localDate: string): Promise<boolean>;
  createDraft(articleId: number, body: string, now: Date): Promise<number>;
  setDraftTelegramMessage(draftId: number, messageId: number): Promise<boolean>;
  getDraftForCallback(draftId: number): Promise<StoredDraft | null>;
  transitionDraft(
    draftId: number,
    decision: DraftDecision,
    now: Date,
  ): Promise<DraftStatus | null>;
  markDraftFailed(draftId: number): Promise<boolean>;
  completeRun(
    slotKey: string,
    outcome: TerminalRunOutcome,
    errorSummary: string | null,
    now: Date,
  ): Promise<boolean>;
}

export interface XPostingModeRepository {
  getXPostingMode(): Promise<XPostingMode>;
  setXPostingMode(mode: XPostingMode, now: Date): Promise<XPostingMode>;
}

export class SupabaseBotRepository implements BotRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async beginRun(
    slotKey: string,
    localDate: string,
    now: Date,
  ): Promise<boolean> {
    try {
      const { error } = await this.client.from("scheduled_runs").insert({
        slot_key: slotKey,
        local_date: localDate,
        outcome: "running",
        created_at: now.toISOString(),
      });
      if (error === null) return true;
      if (isDuplicate(error)) return false;
      throwRepositoryError("begin_run");
    } catch (error) {
      rethrowRepositoryError(error, "begin_run");
    }
  }

  async getSeenUrls(canonicalUrls: readonly string[]): Promise<Set<string>> {
    const uniqueUrls = [...new Set(canonicalUrls)];
    const seen = new Set<string>();
    try {
      for (const batch of chunkCanonicalUrls(uniqueUrls)) {
        const { data, error } = await this.client
          .from("articles")
          .select("canonical_url")
          .in("canonical_url", batch);
        if (error) throwRepositoryError("get_seen_urls");
        for (const article of data) seen.add(article.canonical_url);
      }
      const legacy = await findLegacyBbcUrls(this.client, uniqueUrls);
      return new Set([...seen, ...legacy]);
    } catch (error) {
      rethrowRepositoryError(error, "get_seen_urls");
    }
  }

  getSelectionHistory(now: Date): Promise<SelectionHistory> {
    return readSelectionHistory(this.client, now);
  }

  async recordArticle(
    article: Article,
    eligible: boolean,
    now: Date,
  ): Promise<number | null> {
    try {
      const { data, error } = await this.client
        .from("articles")
        .insert({
          canonical_url: article.canonicalUrl,
          title: article.title,
          source_name: article.sourceName,
          published_at: article.publishedAt.toISOString(),
          excerpt: article.excerpt,
          eligible,
          created_at: now.toISOString(),
        })
        .select("id")
        .single();
      if (error) {
        if (isDuplicate(error)) return null;
        throwRepositoryError("record_article");
      }
      return requireId(data?.id, "record_article");
    } catch (error) {
      rethrowRepositoryError(error, "record_article");
    }
  }

  async reserveGeminiRequest(
    slotKey: string,
    localDate: string,
  ): Promise<boolean> {
    try {
      const { data, error } = await this.client.rpc("reserve_gemini_request", {
        p_slot_key: slotKey,
        p_local_date: localDate,
      });
      if (error || typeof data !== "boolean") {
        throwRepositoryError("reserve_gemini_request");
      }
      return data;
    } catch (error) {
      rethrowRepositoryError(error, "reserve_gemini_request");
    }
  }

  async createDraft(articleId: number, body: string, now: Date): Promise<number> {
    try {
      const { data, error } = await this.client
        .from("drafts")
        .insert({
          article_id: articleId,
          body,
          status: "pending",
          created_at: now.toISOString(),
        })
        .select("id")
        .single();
      if (error) throwRepositoryError("create_draft");
      return requireId(data?.id, "create_draft");
    } catch (error) {
      rethrowRepositoryError(error, "create_draft");
    }
  }

  async setDraftTelegramMessage(
    draftId: number,
    messageId: number,
  ): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from("drafts")
        .update({ telegram_message_id: messageId })
        .eq("id", draftId)
        .eq("status", "pending")
        .is("telegram_message_id", null)
        .select("id")
        .maybeSingle();
      if (error) throwRepositoryError("set_draft_telegram_message");
      return data !== null;
    } catch (error) {
      rethrowRepositoryError(error, "set_draft_telegram_message");
    }
  }

  async getDraftForCallback(draftId: number): Promise<StoredDraft | null> {
    try {
      const { data: draft, error: draftError } = await this.client
        .from("drafts")
        .select("article_id,body,status,telegram_message_id")
        .eq("id", draftId)
        .maybeSingle();
      if (draftError) throwRepositoryError("get_draft_for_callback");
      if (draft === null) return null;

      const { data: article, error: articleError } = await this.client
        .from("articles")
        .select("canonical_url")
        .eq("id", draft.article_id)
        .single();
      if (articleError || article === null || !isDraftStatus(draft.status)) {
        throwRepositoryError("get_draft_for_callback");
      }

      return {
        body: draft.body,
        canonicalUrl: article.canonical_url,
        status: draft.status,
        telegramMessageId: draft.telegram_message_id,
      };
    } catch (error) {
      rethrowRepositoryError(error, "get_draft_for_callback");
    }
  }

  async transitionDraft(
    draftId: number,
    decision: DraftDecision,
    now: Date,
  ): Promise<DraftStatus | null> {
    try {
      const { data, error } = await this.client.rpc("transition_draft", {
        p_draft_id: draftId,
        p_decision: decision,
        p_decided_at: now.toISOString(),
      });
      if (error) throwRepositoryError("transition_draft");
      if (data === null) return null;
      if (!isDraftStatus(data)) throwRepositoryError("transition_draft");
      return data;
    } catch (error) {
      rethrowRepositoryError(error, "transition_draft");
    }
  }

  async markDraftFailed(draftId: number): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from("drafts")
        .update({ status: "failed" })
        .eq("id", draftId)
        .eq("status", "pending")
        .is("telegram_message_id", null)
        .select("id")
        .maybeSingle();
      if (error) throwRepositoryError("mark_draft_failed");
      return data !== null;
    } catch (error) {
      rethrowRepositoryError(error, "mark_draft_failed");
    }
  }

  async completeRun(
    slotKey: string,
    outcome: TerminalRunOutcome,
    errorSummary: string | null,
    now: Date,
  ): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from("scheduled_runs")
        .update({
          outcome,
          error_summary: errorSummary,
          completed_at: now.toISOString(),
        })
        .eq("slot_key", slotKey)
        .eq("outcome", "running")
        .select("slot_key")
        .maybeSingle();
      if (error) throwRepositoryError("complete_run");
      return data !== null;
    } catch (error) {
      rethrowRepositoryError(error, "complete_run");
    }
  }

  async getXPostingMode(): Promise<XPostingMode> {
    try {
      const { data, error } = await this.client
        .from("bot_settings")
        .select("x_posting_mode")
        .eq("id", 1)
        .single();
      if (error || data === null) throwRepositoryError("get_x_posting_mode");
      return requireXPostingMode(data.x_posting_mode, "get_x_posting_mode");
    } catch (error) {
      rethrowRepositoryError(error, "get_x_posting_mode");
    }
  }

  async setXPostingMode(
    mode: XPostingMode,
    now: Date,
  ): Promise<XPostingMode> {
    try {
      const { data, error } = await this.client
        .from("bot_settings")
        .update({
          x_posting_mode: mode,
          updated_at: now.toISOString(),
        })
        .eq("id", 1)
        .select("x_posting_mode")
        .single();
      if (error || data === null) throwRepositoryError("set_x_posting_mode");
      return requireXPostingMode(data.x_posting_mode, "set_x_posting_mode");
    } catch (error) {
      rethrowRepositoryError(error, "set_x_posting_mode");
    }
  }
}

function chunkCanonicalUrls(canonicalUrls: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let encodedLength = 2;

  for (const canonicalUrl of canonicalUrls) {
    const itemLength = encodeURIComponent(canonicalUrl).length + 3;
    if (
      batch.length > 0 &&
      (batch.length >= URL_LOOKUP_BATCH_SIZE ||
        encodedLength + itemLength > URL_LOOKUP_MAX_ENCODED_LENGTH)
    ) {
      batches.push(batch);
      batch = [];
      encodedLength = 2;
    }
    batch.push(canonicalUrl);
    encodedLength += itemLength;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

function isDuplicate(error: { code?: string }): boolean {
  return error.code === "23505";
}

function isDraftStatus(value: unknown): value is DraftStatus {
  return value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "failed";
}

function requireXPostingMode(
  value: unknown,
  operation: string,
): XPostingMode {
  if (value === "off" || value === "manual" || value === "auto") return value;
  throwRepositoryError(operation);
}

function requireId(value: unknown, operation: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throwRepositoryError(operation);
  }
  return value;
}

function throwRepositoryError(operation: string): never {
  throw new Error(`repository_error:${operation}`);
}

function rethrowRepositoryError(error: unknown, operation: string): never {
  if (
    error instanceof Error &&
    error.message === `repository_error:${operation}`
  ) {
    throw error;
  }
  throwRepositoryError(operation);
}
