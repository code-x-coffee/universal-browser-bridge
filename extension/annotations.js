(function () {
  if (globalThis.__ubbAnnotations) return;
  const { selectorFor, pageRect } = globalThis.__ubbAnnotationUtils;
  const host = document.createElement("div");
  host.id = "ubb-annotations-host";
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 14px/1.4 system-ui,sans-serif; }
    button,textarea { pointer-events:auto; }
    button { cursor:pointer; border:0; border-radius:6px; padding:6px 10px; background:#0e7490; color:white; }
    button:disabled { opacity:.5; cursor:wait; }
    .hint { position:fixed; top:12px; left:50%; transform:translateX(-50%); background:#164e63; color:white; border-radius:8px; padding:8px 12px; }
    .outline { position:fixed; border:2px solid #0891b2; background:#06b6d422; display:none; }
    .popup,.comment { position:fixed; width:280px; max-width:calc(100vw - 16px); background:white; color:#111827; border:1px solid #0891b2; border-radius:8px; padding:12px; box-shadow:0 4px 18px #0003; pointer-events:auto; }
    textarea { width:100%; min-height:85px; resize:vertical; border:1px solid #94a3b8; color:#111827; background:white; border-radius:4px; padding:6px; margin-bottom:8px; }
    .error { color:#b91c1c; margin:6px 0; }
    .pin { position:fixed; border-radius:50%; min-width:26px; height:26px; padding:2px 5px; box-shadow:0 1px 5px #0005; }
    .answered { background:#15803d; }
    .answered::after { content:""; position:absolute; right:-2px; top:-2px; width:8px; height:8px; border:1px solid white; border-radius:50%; background:#15803d; }
    .resolved { background:#64748b; }
    .comment { white-space:pre-wrap; overflow-wrap:anywhere; max-height:45vh; overflow:auto; }
  `;
  root.append(style);
  const outline = document.createElement("div");
  outline.className = "outline";
  root.append(outline);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Click an element or drag a region. Esc exits annotations.";
  hint.hidden = true;
  root.append(hint);
  const pins = document.createElement("div");
  root.append(pins);
  let mode = false;
  let gesture;
  let popup;
  let commentPopup;
  let commentHideTimer;
  let annotations = [];
  let pinNodes = [];
  let frame;
  let saving = false;
  let destroyed = false;
  let pageUrl = location.href;

  const isUI = (event) => event.composedPath().includes(host);
  const suppress = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const place = (node, x, y) => {
    node.style.left = `${Math.max(8, Math.min(x, innerWidth - 288))}px`;
    node.style.top = `${Math.max(8, Math.min(y, innerHeight - node.offsetHeight - 8))}px`;
  };
  const showOutline = (rect) => {
    Object.assign(outline.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  };
  const closePopup = () => { popup?.remove(); popup = undefined; outline.style.display = "none"; };
  const hideComment = () => { clearTimeout(commentHideTimer); commentPopup?.remove(); commentPopup = undefined; };
  // Allow crossing the small gap between a pin and its scrollable thread.
  const hideCommentLater = () => { clearTimeout(commentHideTimer); commentHideTimer = setTimeout(hideComment, 200); };
  const setMode = (next) => {
    mode = next;
    hint.hidden = !next;
    gesture = undefined;
    if (!next) closePopup();
  };

  function positionPins() {
    for (let i = 0; i < annotations.length; i++) {
      const item = annotations[i];
      let element;
      try { element = item.selector && document.querySelector(item.selector); } catch { /* fall back to saved coordinates */ }
      const rect = element?.getBoundingClientRect();
      const x = rect ? rect.left + (item.anchorOffset?.x || 0) : item.rect.x - scrollX;
      const y = rect ? rect.top + (item.anchorOffset?.y || 0) : item.rect.y - scrollY;
      pinNodes[i].style.left = `${x}px`;
      pinNodes[i].style.top = `${y}px`;
    }
  }
  function schedulePosition() {
    if (frame || destroyed) return;
    frame = requestAnimationFrame(() => { frame = undefined; positionPins(); });
  }
  function showComment(item, pin) {
    hideComment();
    commentPopup = document.createElement("div");
    commentPopup.className = "comment";
    commentPopup.tabIndex = 0;
    commentPopup.addEventListener("mouseenter", () => clearTimeout(commentHideTimer));
    commentPopup.addEventListener("focus", () => clearTimeout(commentHideTimer));
    commentPopup.addEventListener("mouseleave", hideCommentLater);
    commentPopup.addEventListener("blur", hideCommentLater);
    commentPopup.textContent = `${item.status === "resolved" ? "Resolved\n" : ""}${item.comment}${item.resolutionNote ? `\n\nResolution: ${item.resolutionNote}` : ""}`;
    for (const reply of item.replies || []) {
      const entry = document.createElement("div");
      entry.className = "reply";
      entry.textContent = `\n\n${reply.author} · ${new Date(reply.createdAt).toLocaleString()}\n${reply.text}`;
      commentPopup.append(entry);
    }
    root.append(commentPopup);
    const rect = pin.getBoundingClientRect();
    place(commentPopup, rect.right + 8, rect.top);
  }
  function render(items) {
    if (location.href !== pageUrl) return;
    annotations = items;
    pins.replaceChildren();
    hideComment();
    pinNodes = items.map((item, index) => {
      const pin = document.createElement("button");
      const state = item.status === "resolved" ? "resolved" : item.replies?.length ? "answered" : "";
      const label = state === "resolved" ? "Resolved" : state === "answered" ? "Answered" : "Open";
      pin.className = `pin ${state}`;
      pin.textContent = String(index + 1);
      pin.title = `${label} annotation ${index + 1}`;
      pin.setAttribute("aria-label", `${label} annotation ${index + 1}: ${item.comment}`);
      pin.addEventListener("mouseenter", () => showComment(item, pin));
      pin.addEventListener("mouseleave", hideCommentLater);
      pin.addEventListener("focus", () => showComment(item, pin));
      pin.addEventListener("blur", hideCommentLater);
      pin.addEventListener("click", () => showComment(item, pin));
      pins.append(pin);
      return pin;
    });
    positionPins();
  }

  function openPopup(rect, element) {
    closePopup();
    showOutline({ left: rect.x - scrollX, top: rect.y - scrollY, width: rect.width, height: rect.height });
    const draft = {
      selector: selectorFor(element),
      textSnippet: (element?.textContent || "").trim().slice(0, 200), rect,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      scroll: { x: scrollX, y: scrollY }, url: location.href, title: document.title
    };
    if (draft.selector) {
      const anchor = element.getBoundingClientRect();
      draft.anchorOffset = { x: rect.x - scrollX - anchor.left, y: rect.y - scrollY - anchor.top };
    }
    popup = document.createElement("div");
    popup.className = "popup";
    const editor = document.createElement("textarea");
    editor.placeholder = "What should change here?";
    editor.setAttribute("aria-label", "Annotation comment");
    editor.maxLength = 10000;
    const save = document.createElement("button");
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.marginLeft = "8px";
    const error = document.createElement("div");
    error.className = "error";
    cancel.addEventListener("click", closePopup);
    save.addEventListener("click", async () => {
      if (saving || !editor.value.trim()) return;
      saving = true;
      save.disabled = true;
      // Capture with the entire host hidden, including pins and comments.
      host.style.setProperty("visibility", "hidden", "important");
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const response = await chrome.runtime.sendMessage({ type: "ubbAnnotationSave", annotation: {
          ...draft, comment: editor.value.trim(), scroll: { x: scrollX, y: scrollY },
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }
        } });
        if (response?.error) throw new Error(response.error);
        if (!response?.result) throw new Error("The daemon did not save the annotation");
        closePopup();
      } catch (failure) {
        error.textContent = failure.message || String(failure);
      } finally {
        host.style.removeProperty("visibility");
        saving = false;
        save.disabled = false;
      }
    });
    popup.append(editor, save, cancel, error);
    root.append(popup);
    place(popup, rect.x - scrollX, rect.y - scrollY + rect.height + 8);
    editor.focus();
  }

  function down(event) {
    if (!mode || isUI(event)) return;
    suppress(event);
    if (popup || saving || event.button !== 0) return;
    gesture = { x: event.clientX, y: event.clientY, element: event.target };
  }
  function move(event) {
    if (!mode || isUI(event) || popup || saving) return;
    if (gesture) {
      showOutline({ left: Math.min(gesture.x, event.clientX), top: Math.min(gesture.y, event.clientY), width: Math.abs(event.clientX - gesture.x), height: Math.abs(event.clientY - gesture.y) });
    } else if (event.target instanceof Element) showOutline(event.target.getBoundingClientRect());
  }
  function up(event) {
    if (!mode || isUI(event)) return;
    suppress(event);
    if (!gesture) return;
    const start = gesture;
    gesture = undefined;
    const width = Math.abs(event.clientX - start.x);
    const height = Math.abs(event.clientY - start.y);
    if (Math.max(width, height) > 5) {
      const left = Math.min(start.x, event.clientX);
      const top = Math.min(start.y, event.clientY);
      openPopup(pageRect({ left, top, width, height }), document.elementFromPoint(left + width / 2, top + height / 2));
    } else if (start.element instanceof Element) openPopup(pageRect(start.element.getBoundingClientRect()), start.element);
  }
  function blockClick(event) { if (mode && !isUI(event)) suppress(event); }
  function key(event) {
    if (event.key === "Escape" && (mode || commentPopup)) {
      suppress(event);
      setMode(false);
      hideComment();
    } else if (mode && !isUI(event)) suppress(event);
  }
  const listeners = { pointerdown: down, pointermove: move, pointerup: up, click: blockClick, dblclick: blockClick, contextmenu: blockClick, keydown: key, keyup: blockClick, mousedown: blockClick, mouseup: blockClick };
  for (const [type, listener] of Object.entries(listeners)) window.addEventListener(type, listener, true);
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);
  const observer = new MutationObserver(schedulePosition);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });

  function receive(message, _sender, respond) {
    if (message.type === "ubbAnnotationsCaptureContext") {
      respond({ url: location.href, hidden: host.style.visibility === "hidden", scroll: { x: scrollX, y: scrollY } });
    }
    if (message.type === "ubbAnnotationsToggle") setMode(!mode);
    if (message.type === "ubbAnnotationsRender" && message.url === location.href) {
      if (pageUrl !== message.url) setMode(false);
      pageUrl = message.url;
      render(message.annotations);
    }
    if (message.type === "ubbAnnotationsDestroy") destroy();
  }
  chrome.runtime.onMessage.addListener(receive);
  function destroy() {
    destroyed = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearInterval(urlTimer);
    clearTimeout(commentHideTimer);
    for (const [type, listener] of Object.entries(listeners)) window.removeEventListener(type, listener, true);
    window.removeEventListener("scroll", schedulePosition, true);
    window.removeEventListener("resize", schedulePosition);
    chrome.runtime.onMessage.removeListener(receive);
    host.remove();
    delete globalThis.__ubbAnnotations;
  }
  // pushState/replaceState need no extension permission, but do change the
  // annotation identity. Detect them as well as normal document reloads.
  const urlTimer = setInterval(() => {
    if (location.href === pageUrl) return;
    pageUrl = location.href;
    setMode(false);
    render([]);
    chrome.runtime.sendMessage({ type: "ubbAnnotationsReload" }).catch(() => {});
  }, 500);
  globalThis.__ubbAnnotations = { destroy };
})();
