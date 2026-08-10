import type { FeedDefinition } from "./types";

export function parseFeeds(raw: string): FeedDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RSS_FEEDS_JSON must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("RSS_FEEDS_JSON must be an array of feed definitions");
  }

  return parsed.map((value, index) => parseFeedDefinition(value, index));
}

function parseFeedDefinition(value: unknown, index: number): FeedDefinition {
  if (!isRecord(value)) {
    throw new Error(`RSS_FEEDS_JSON[${index}] must be an object`);
  }

  const { name, url, priority } = value;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`RSS_FEEDS_JSON[${index}].name must be a non-empty string`);
  }
  if (typeof url !== "string" || !isHttpsUrl(url)) {
    throw new Error(`RSS_FEEDS_JSON[${index}].url must be an HTTPS URL`);
  }
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    throw new Error(`RSS_FEEDS_JSON[${index}].priority must be a finite number`);
  }

  return { name: name.trim(), url, priority };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
