import { describe, expect, it } from "vitest";
import { vietnamDayBounds } from "../../supabase/functions/_shared/editorial-history";

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
});
