import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { annotationDraft } from "./test-support/annotation-fixture.js";

const utils = await readFile(new URL("../extension/annotation-utils.js", import.meta.url), "utf8");
const ui = await readFile(new URL("../extension/annotations.js", import.meta.url), "utf8");
let document: any;
class Node {
  localName: string;
  id = "";
  className = "";
  textContent = "";
  value = "";
  parentElement?: Node;
  children: Node[] = [];
  shadow?: Node;
  hidden = false;
  offsetHeight = 110;
  style: any = { setProperty: (key: string, value: string) => { this.style[key] = value; }, removeProperty: (key: string) => { delete this.style[key]; } };
  events = new Map<string, (...args: any[]) => any>();
  rect = { left: 100, top: 200, width: 120, height: 50, right: 220, bottom: 250 };
  constructor(tag: string) { this.localName = tag; }
  append(...nodes: Node[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]) { this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); }
  attachShadow() { this.shadow = new Node("shadow"); return this.shadow; }
  getRootNode() { return document; }
  getBoundingClientRect() { return this.rect; }
  setAttribute() {}
  addEventListener(type: string, listener: (...args: any[]) => any) { this.events.set(type, listener); }
  focus() {}
}
let context: any;
let receive: (message: any) => void;
let page: Node;
let listeners: Map<string, (event: any) => void>;
let send: ReturnType<typeof vi.fn>;
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const root = () => document.documentElement.children.find((node: Node) => node.id === "ubb-annotations-host").shadow as Node;
const popup = () => root().children.find((node) => node.className === "popup")!;
const event = (target: Node, props: any = {}) => ({ target, clientX: 110, clientY: 210, button: 0, composedPath: () => [target], preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...props });

beforeEach(() => {
  vi.useFakeTimers();
  const html = new Node("html");
  page = new Node("h1"); page.id = "heading";
  html.append(page);
  document = {
    documentElement: html, title: "Example", createElement: (tag: string) => new Node(tag),
    querySelectorAll: (selector: string) => selector === "#heading" ? [page] : [],
    querySelector: (selector: string) => selector === "#heading" ? page : undefined,
    elementFromPoint: () => page
  };
  listeners = new Map();
  send = vi.fn().mockResolvedValue({ result: { id: "saved" } });
  context = {
    document, Element: Node, CSS: { escape: vi.fn((value: string) => value) },
    location: { href: annotationDraft.url }, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 2,
    scrollX: 0, scrollY: 200,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    setInterval, clearInterval,
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { sendMessage: send, onMessage: { addListener: (fn: typeof receive) => { receive = fn; }, removeListener() {} } } },
    window: { addEventListener: (type: string, fn: (event: any) => void) => { listeners.set(type, fn); }, removeEventListener: (type: string) => { listeners.delete(type); } }
  };
  runInNewContext(utils + "\n" + ui, context);
});
afterEach(() => { context.__ubbAnnotations?.destroy(); vi.clearAllTimers(); vi.useRealTimers(); });

function selectElement() {
  receive({ type: "ubbAnnotationsToggle" });
  listeners.get("pointerdown")!(event(page));
  listeners.get("pointerup")!(event(page));
}

it("creates a closed shadow root, suppresses page clicks and exits on Escape", () => {
  expect(root()).toBeDefined();
  receive({ type: "ubbAnnotationsToggle" });
  const click = event(page);
  listeners.get("click")!(click);
  expect(click.preventDefault).toHaveBeenCalled();
  expect(click.stopImmediatePropagation).toHaveBeenCalled();
  listeners.get("pointerdown")!(event(page)); listeners.get("pointerup")!(event(page));
  expect(popup()).toBeDefined();
  listeners.get("keydown")!(event(page, { key: "Escape" }));
  expect(popup()).toBeUndefined();
  const after = event(page);
  listeners.get("click")!(after);
  expect(after.preventDefault).not.toHaveBeenCalled();
});

it.each(["success", "failure"])("hides the entire overlay during capture and restores it after %s", async (outcome) => {
  selectElement();
  const editor = popup().children.find((node) => node.localName === "textarea")!;
  editor.value = "Fix heading";
  send.mockImplementation(async (message: any) => {
    const host = document.documentElement.children.find((node: Node) => node.id === "ubb-annotations-host");
    expect(host.style.visibility).toBe("hidden");
    expect(message).toMatchObject({ type: "ubbAnnotationSave", annotation: { comment: "Fix heading", selector: "#heading", rect: { x: 100, y: 400 }, viewport: { devicePixelRatio: 2 }, scroll: { y: 200 }, url: annotationDraft.url } });
    if (outcome === "failure") throw new Error("Capture failed");
    return { result: { id: "saved" } };
  });
  const save = popup().children.find((node) => node.textContent === "Save")!;
  const saving = save.events.get("click")!();
  await vi.advanceTimersByTimeAsync(10);
  await saving;
  const host = document.documentElement.children.find((node: Node) => node.id === "ubb-annotations-host");
  expect(host.style.visibility).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
  if (outcome === "failure") expect(all(popup()).some((node) => node.textContent === "Capture failed")).toBe(true);
  else expect(popup()).toBeUndefined();
});

it("selects a drag region using page coordinates and retains its offset from the center element", async () => {
  receive({ type: "ubbAnnotationsToggle" });
  listeners.get("pointerdown")!(event(page, { clientX: 120, clientY: 220 }));
  listeners.get("pointermove")!(event(page, { clientX: 180, clientY: 260 }));
  listeners.get("pointerup")!(event(page, { clientX: 180, clientY: 260 }));
  popup().children.find((node) => node.localName === "textarea")!.value = "Region note";
  const saving = popup().children.find((node) => node.textContent === "Save")!.events.get("click")!();
  await vi.advanceTimersByTimeAsync(10); await saving;
  expect(send.mock.calls[0]![0].annotation).toMatchObject({ rect: { x: 120, y: 420, width: 60, height: 40 }, anchorOffset: { x: 20, y: 20 }, selector: "#heading" });
});

it("renders numbered, anchored and resolved pins and displays comments as plain text", () => {
  const item = { ...annotationDraft, id: "one", comment: "<img onerror=attack()>", status: "open" };
  receive({ type: "ubbAnnotationsRender", url: annotationDraft.url, annotations: [item] });
  let pin = all(root()).find((node) => node.className === "pin ")!;
  expect(pin.textContent).toBe("1");
  expect(pin.style.left).toBe("100px");
  pin.events.get("click")!();
  expect(all(root()).find((node) => node.className === "comment")?.textContent).toBe(item.comment);
  receive({ type: "ubbAnnotationsRender", url: annotationDraft.url, annotations: [{ ...item, selector: null, status: "resolved", resolutionNote: "Done" }] });
  pin = all(root()).find((node) => node.className === "pin resolved")!;
  expect(pin.style.left).toBe("10px"); expect(pin.style.top).toBe("20px");
  pin.events.get("click")!();
  expect(all(root()).find((node) => node.className === "comment")?.textContent).toContain("Resolution: Done");
});

it("clears pins on SPA navigation and cleans up listeners when unshared", async () => {
  receive({ type: "ubbAnnotationsRender", url: annotationDraft.url, annotations: [{ ...annotationDraft, status: "open" }] });
  context.location.href = "https://example.com/next";
  await vi.advanceTimersByTimeAsync(500);
  expect(all(root()).some((node) => node.className.startsWith("pin "))).toBe(false);
  expect(send).toHaveBeenCalledWith({ type: "ubbAnnotationsReload" });
  receive({ type: "ubbAnnotationsDestroy" });
  expect(listeners.size).toBe(0);
  expect(context.__ubbAnnotations).toBeUndefined();
});

it("generates structural selectors for duplicate IDs and escapes unique IDs", () => {
  expect(context.__ubbAnnotationUtils.selectorFor(page)).toBe("#heading");
  expect(context.CSS.escape).toHaveBeenCalledWith("heading");
  const sibling = new Node("h1"); sibling.id = "heading"; document.documentElement.append(sibling);
  document.querySelectorAll = () => [page, sibling];
  document.querySelector = (selector: string) => selector === "html > h1:nth-of-type(2)" ? sibling : null;
  expect(context.__ubbAnnotationUtils.selectorFor(sibling)).toBe("html > h1:nth-of-type(2)");
  const shadowElement = new Node("span"); shadowElement.getRootNode = () => new Node("shadow");
  expect(context.__ubbAnnotationUtils.selectorFor(shadowElement)).toBeNull();
});
