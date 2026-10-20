import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { uploadFileScript, snapshotScript } from "./dom-actions.js";

function input(properties: Record<string, unknown> = {}) {
  return { tagName: "INPUT", multiple: false, disabled: false, matches: (selector: string) => selector === 'input[type="file"]', ...properties };
}
function resolve(el: unknown, count = 1) {
  return runInNewContext(uploadFileScript("ubb-3", count), { document: { querySelector(selector: string) {
    expect(selector).toBe('[data-ubb-ref="ubb-3"]'); return el;
  } } });
}
it("resolves direct, associated label and single descendant file inputs", () => {
  const file = input();
  expect(resolve(file)).toBe(file);
  expect(resolve({ tagName: "LABEL", matches: () => false, control: file })).toBe(file);
  expect(resolve({ tagName: "BUTTON", matches: () => false, querySelectorAll: () => [file] })).toBe(file);
  expect(resolve(input({ multiple: true }), 2)).toHaveProperty("multiple", true);
});
it("rejects expired refs, other elements and ambiguous descendants", () => {
  expect(() => resolve(null)).toThrow("Element ref expired; take a new snapshot");
  for (const files of [[], [input(), input()]]) {
    expect(() => resolve({ matches: () => false, querySelectorAll: () => files })).toThrow("Target is not a file input (or a label/button containing one)");
  }
});
it("rejects disabled inputs including disabled fieldsets and excess files", () => {
  expect(() => resolve(input({ disabled: true }))).toThrow(/disabled/);
  expect(() => resolve(input({ matches: () => true }))).toThrow(/disabled/);
  expect(() => resolve(input(), 2)).toThrow(/multiple/);
});
it("makes visible labels available in snapshots for hidden file inputs", () => {
  expect(snapshotScript).toContain("a,button,input,label,textarea");
});
