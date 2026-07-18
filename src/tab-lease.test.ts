import { describe, expect, it } from "vitest";
import { TabLeaseManager } from "./tab-lease.js";

describe("TabLeaseManager", () => {
  it("starts every tab at generation 0", () => {
    const leases = new TabLeaseManager();
    expect(leases.getGeneration(1)).toBe(0);
  });

  it("bumps the generation for a tab", () => {
    const leases = new TabLeaseManager();
    leases.bumpGeneration(42);
    expect(leases.getGeneration(42)).toBe(1);
    leases.bumpGeneration(42);
    expect(leases.getGeneration(42)).toBe(2);
  });

  it("bumping one tab does not affect another tab's generation", () => {
    const leases = new TabLeaseManager();
    leases.bumpGeneration(1);
    expect(leases.getGeneration(2)).toBe(0);
  });

  it("serializes concurrent operations on the same tab", async () => {
    const leases = new TabLeaseManager();
    const order: string[] = [];
    const slow = leases.runExclusive(1, async () => {
      order.push("slow-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("slow-end");
      return "slow";
    });
    const fast = leases.runExclusive(1, async () => {
      order.push("fast-start");
      order.push("fast-end");
      return "fast";
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow-start", "slow-end", "fast-start", "fast-end"]);
  });

  it("runs operations on different tabs concurrently", async () => {
    const leases = new TabLeaseManager();
    const order: string[] = [];
    const a = leases.runExclusive(1, async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a-end");
    });
    const b = leases.runExclusive(2, async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([a, b]);
    // Tab 2's work finishes while tab 1's slow op is still pending, proving
    // the two tabs don't share a lease.
    expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
  });

  it("a rejected operation does not block the next queued operation", async () => {
    const leases = new TabLeaseManager();
    const first = leases.runExclusive(1, async () => {
      throw new Error("boom");
    });
    const second = leases.runExclusive(1, async () => "recovered");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("recovered");
  });

  it("propagates the return value of the operation", async () => {
    const leases = new TabLeaseManager();
    const result = await leases.runExclusive(1, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it("forgetting a tab resets its generation", () => {
    const leases = new TabLeaseManager();
    leases.bumpGeneration(5);
    leases.forgetTab(5);
    expect(leases.getGeneration(5)).toBe(0);
  });
});
