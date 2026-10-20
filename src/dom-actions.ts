// DOM/CDP scripts shared by the daemon's ref-based click/type/snapshot
// handlers. Kept here (rather than in mcp.ts) because the daemon must own
// their execution to enforce snapshot-generation checks centrally.

export const snapshotScript = String.raw`
(() => {
  document.querySelectorAll('[data-ubb-ref]').forEach((el) => el.removeAttribute('data-ubb-ref'));
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const nodes = [...document.querySelectorAll('a,button,input,label,textarea,select,video,img,audio,[role],[contenteditable="true"]')]
    .filter(visible)
    .slice(0, 250)
    .map((el, index) => {
      const ref = 'ubb-' + index;
      el.setAttribute('data-ubb-ref', ref);
      const rect = el.getBoundingClientRect();
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        type: el.getAttribute('type') || undefined,
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 300),
        value: 'value' in el && el.type !== 'password' ? String(el.value).slice(0, 300) : undefined,
        disabled: Boolean(el.disabled),
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2)
      };
    });
  return { title: document.title, url: location.href, nodes };
})()
`;

export function clickDetailsScript(ref: string): string {
  return `(() => { const el = document.querySelector('[data-ubb-ref="${ref}"]'); if (!el) throw new Error('Element ref expired; take a new snapshot'); return { text: (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 300), type: el.getAttribute('type'), href: el.href || '', formAction: el.formAction || '' }; })()`;
}

export function clickTargetScript(ref: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(`[data-ubb-ref="${ref}"]`)});
    if (!el) throw new Error('Element ref expired; take a new snapshot');
    el.scrollIntoView({block:'center', inline:'center'});
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const style = getComputedStyle(el);
    const hasSize = rect.width > 0 && rect.height > 0;
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hasSize, visible, hitTarget: hit === el || (hit !== null && el.contains(hit)) };
  })()`;
}

export function clickScript(ref: string): string {
  return `(() => { const el = document.querySelector('[data-ubb-ref="${ref}"]'); if (!el) throw new Error('Element ref expired; take a new snapshot'); el.click(); return true; })()`;
}

export function typeScript(ref: string, input: string): string {
  return `(() => { const el = document.querySelector('[data-ubb-ref="${ref}"]'); if (!el) throw new Error('Element ref expired; take a new snapshot'); el.focus(); if ('value' in el) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; setter ? setter.call(el, ${JSON.stringify(input)}) : el.value = ${JSON.stringify(input)}; } else { el.textContent = ${JSON.stringify(input)}; } el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`;
}

export function scrollScript(deltaY: number): string {
  return `window.scrollBy({top:${deltaY},behavior:'instant'}); ({x:scrollX,y:scrollY})`;
}

export function uploadFileScript(ref: string, fileCount: number, allowChooser = false): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(`[data-ubb-ref="${ref}"]`)});
    if (!el) throw new Error('Element ref expired; take a new snapshot');
    const isFileInput = (node) => node?.matches('input[type="file"]');
    let input;
    if (isFileInput(el)) input = el;
    else if (el.tagName === 'LABEL' && isFileInput(el.control)) input = el.control;
    else {
      const inputs = el.querySelectorAll('input[type="file"]');
      if (inputs.length === 1) input = inputs[0];
    }
    if (!input) ${allowChooser ? "return null;" : "throw new Error('Target is not a file input (or a label/button containing one)');"}
    if (input.disabled || input.matches(':disabled')) throw new Error('File input is disabled');
    if (${fileCount} > 1 && !input.multiple) throw new Error('File input does not allow multiple files');
    return input;
  })()`;
}

const KEY_DESCRIPTORS: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  NumpadEnter: { code: "NumpadEnter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { code: "Home", windowsVirtualKeyCode: 36 },
  End: { code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 }
};

export function describeKey(key: string): { code?: string; windowsVirtualKeyCode?: number; text?: string } {
  return KEY_DESCRIPTORS[key] ?? (key.length === 1 ? { text: key } : {});
}
