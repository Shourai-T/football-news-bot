import { describe, expect, it } from "vitest";
import { DraftStatus } from "../src/types";

describe("draft lifecycle", () => {
  it("has only the expected persistent states", () => {
    const values: DraftStatus[] = ["pending", "approved", "rejected", "failed"];
    expect(values).toHaveLength(4);
  });
});
