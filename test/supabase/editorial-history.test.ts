import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../supabase/functions/_shared/database.types";
import {
  readSelectionHistory,
  vietnamDayBounds,
} from "../../supabase/functions/_shared/editorial-history";

describe("Vietnam editorial history bounds", () => {
  it.each([
    ["2026-08-31T16:59:59.999Z", "2026-08-30T17:00:00.000Z", "2026-08-31T17:00:00.000Z"],
    ["2026-08-31T17:00:00.000Z", "2026-08-31T17:00:00.000Z", "2026-09-01T17:00:00.000Z"],
    ["2026-12-31T17:00:00.000Z", "2026-12-31T17:00:00.000Z", "2027-01-01T17:00:00.000Z"],
  ])("maps %s to a half-open Vietnam day", (input, start, end) => {
    expect(vietnamDayBounds(new Date(input))).toEqual({ start, end });
  });
  it("rejects invalid run times", () => {
    expect(() => vietnamDayBounds(new Date("invalid"))).toThrow("invalid_scheduled_time");
  });

  it("redacts provider failures while reading history", async () => {
    let query: Record<string, unknown>;
    query = new Proxy({}, {
      get: (_target, property) => property === "then"
        ? (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
          Promise.resolve({ data: null, error: { message: "PRIVATE_PROVIDER_DETAIL" } })
            .then(resolve, reject)
        : () => query,
    });
    const client = {
      from: () => query,
    } as unknown as SupabaseClient<Database>;

    const failure = readSelectionHistory(client, new Date("2026-08-31T12:00:00Z"));

    await expect(failure).rejects.toThrow("repository_error:get_selection_history");
    await expect(failure).rejects.not.toThrow("PRIVATE_PROVIDER_DETAIL");
  });
});
