import type { Article } from "./domain-types.ts";

export type EditorialType = "transfer" | "contract" | "injury" | "match" | "quote" | "stat" | "general";
export interface EventFeatures { key: string; materialNumbers: readonly string[]; }
export interface EditorialFeatures {
  sourceId: string;
  entities: readonly string[];
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
