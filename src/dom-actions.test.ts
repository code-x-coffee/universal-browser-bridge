import { describe, expect, it } from "vitest";
import { describeKey, snapshotScript, clickDetailsScript, clickScript, scrollScript, typeScript } from "./dom-actions.js";

describe("dom-actions script builders", () => {
  it("embeds the ref into the click details script", () => {
    expect(clickDetailsScript("ubb-3")).toContain('data-ubb-ref="ubb-3"');
  });

  it("embeds the ref into the click script", () => {
    const script = clickScript("ubb-7");
    expect(script).toContain('data-ubb-ref="ubb-7"');
    expect(script).toContain(".click()");
  });

  it("embeds the ref and JSON-escaped text into the type script", () => {
    const script = typeScript("ubb-1", 'hello "world"');
    expect(script).toContain('data-ubb-ref="ubb-1"');
    expect(script).toContain(JSON.stringify('hello "world"'));
  });

  it("embeds the delta into the scroll script", () => {
    expect(scrollScript(250)).toContain("250");
  });

  it("snapshot script strips previous refs and caps node count", () => {
    expect(snapshotScript).toContain("removeAttribute('data-ubb-ref')");
    expect(snapshotScript).toContain("slice(0, 250)");
  });

  it("resolves known key names to CDP descriptors", () => {
    expect(describeKey("Enter")).toMatchObject({ code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(describeKey("Tab")).toMatchObject({ code: "Tab", windowsVirtualKeyCode: 9 });
  });

  it("treats a single printable character as literal text input", () => {
    expect(describeKey("a")).toEqual({ text: "a" });
  });

  it("falls back to an empty descriptor for unknown multi-character keys", () => {
    expect(describeKey("F13")).toEqual({});
  });
});
