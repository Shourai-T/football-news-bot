import { describe, expect, it } from "vitest";
import { parsePublicationDate } from "../../supabase/functions/_shared/feed-date";

describe("explicit feed timestamps", () => {
  it.each([
    ["Mon, 31 Aug 2026 09:54:00 BST", "sky-uk", "2026-08-31T08:54:00.000Z"],
    ["Mon, 31 Aug 2026 09:54:00 GMT", "standard", "2026-08-31T09:54:00.000Z"],
    ["31 Aug 2026 09:54:00 UTC", "standard", "2026-08-31T09:54:00.000Z"],
    ["31 Aug 2026 09:54:00 -0430", "standard", "2026-08-31T14:24:00.000Z"],
    ["2026-08-31T09:54:00+07:00", "standard", "2026-08-31T02:54:00.000Z"],
    ["2026-08-31T09:54:00+0700", "standard", "2026-08-31T02:54:00.000Z"],
    ["2026-08-31T09:54:00.1Z", "standard", "2026-08-31T09:54:00.100Z"],
    ["2026-08-31T09:54:00.123Z", "standard", "2026-08-31T09:54:00.123Z"],
    ["2024-02-29T23:59:59Z", "standard", "2024-02-29T23:59:59.000Z"],
    ["0099-01-01T00:00:00Z", "standard", "0099-01-01T00:00:00.000Z"],
  ] as const)("converts %s without host timezone assumptions", (input, policy, expected) => {
    expect(parsePublicationDate(input, policy)?.toISOString()).toBe(expected);
  });

  it.each([
    "", "not a date", "2026-08-31", "2026-08-31T09:54:00",
    "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-13-01T00:00:00Z",
    "2026-08-31T25:00:00Z", "2026-08-31T09:60:00Z", "2026-08-31T09:54:60Z",
    "2026-08-31T09:54:00+2400", "2026-08-31T09:54:00+0060",
    "Mon, 31 Aug 2026 09:54:00 BST", "Mon, 31 Aug 2026 09:54:00 CST",
    "31 Feb 2026 09:54:00 GMT", "2026-08-31T09:54:00Z extra",
  ])("rejects ambiguous or invalid date %s", (input) => {
    expect(parsePublicationDate(input, "standard")).toBeNull();
  });
});
