import { describe, expect, it } from "vitest";
import { isPotentiallyConsequential, requireConfirmation } from "./policy.js";

describe("browser action policy", () => {
  it("allows ordinary navigation actions", () => {
    expect(isPotentiallyConsequential("open the account settings menu")).toBe(false);
    expect(() => requireConfirmation("open the account settings menu", false)).not.toThrow();
  });

  it("requires confirmation for consequential actions", () => {
    expect(isPotentiallyConsequential("submit the payment form")).toBe(true);
    expect(() => requireConfirmation("submit the payment form", false)).toThrow(/Confirmation required/);
    expect(() => requireConfirmation("submit the payment form", true)).not.toThrow();
  });
});
