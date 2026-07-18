import { describe, expect, it } from "vitest";
import { isPotentiallyConsequential } from "./policy.js";

describe("browser action policy", () => {
  it("allows ordinary navigation actions", () => {
    expect(isPotentiallyConsequential("open the account settings menu")).toBe(false);
  });

  it("requires confirmation for consequential actions", () => {
    expect(isPotentiallyConsequential("submit the payment form")).toBe(true);
    expect(isPotentiallyConsequential("place the order")).toBe(true);
    expect(isPotentiallyConsequential("authorize the integration")).toBe(true);
  });
});
