export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  RSS_FEEDS_JSON: string;
}

export interface FeedDefinition {
  name: string;
  url: string;
  priority: number;
}

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

export type RunOutcome = "running" | "no_candidate" | "draft_sent" | "failed";
