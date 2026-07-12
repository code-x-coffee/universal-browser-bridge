import { describe, expect, it } from "vitest";
import { tokensMatch } from "./auth.js";

describe("token comparison", () => {
  it("accepts only exact tokens", () => {
    expect(tokensMatch("correct-token", "correct-token")).toBe(true);
    expect(tokensMatch("wrong-token", "correct-token")).toBe(false);
    expect(tokensMatch("short", "much-longer-token")).toBe(false);
  });
});
