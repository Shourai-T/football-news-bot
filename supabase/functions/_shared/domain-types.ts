export interface Article {
  title: string;
  excerpt: string;
  sourceName: string;
  canonicalUrl: string;
  publishedAt: Date;
  sourcePriority: number;
  topicScore: number;
}

export type DraftStatus = "pending" | "approved" | "rejected" | "failed";
export type DraftDecision = Extract<DraftStatus, "approved" | "rejected">;

export type TerminalRunOutcome =
  | "no_candidate"
  | "draft_sent"
  | "rss_unavailable"
  | "quota_limited"
  | "gemini_failed"
  | "telegram_failed"
  | "internal_failed";

export interface StoredDraft {
  body: string;
  canonicalUrl: string;
  status: DraftStatus;
  telegramMessageId: number | null;
}
