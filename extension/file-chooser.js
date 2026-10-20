// A chooser transaction stays inside the worker so no CDP event can race a
// round trip through the daemon. Only one transaction may intercept each tab.
const activeChoosers = new Set();

const installPickerShim = `(() => {
  if (window.__ubbRestoreFilePicker) throw new Error('A file picker shim is already active');
  const original = Object.getOwnPropertyDescriptor(window, 'showOpenFilePicker');
  const originalUsed = Object.getOwnPropertyDescriptor(window, '__ubbPickerUsed');
  const originalSelection = Object.getOwnPropertyDescriptor(window, '__ubbPickerSelection');
  const pending = new Map();
  let timer;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    clearTimeout(timer);
    for (const cancel of pending.values()) cancel();
    if (original) Object.defineProperty(window, 'showOpenFilePicker', original);
    else delete window.showOpenFilePicker;
    if (originalUsed) Object.defineProperty(window, '__ubbPickerUsed', originalUsed);
    else delete window.__ubbPickerUsed;
    if (originalSelection) Object.defineProperty(window, '__ubbPickerSelection', originalSelection);
    else delete window.__ubbPickerSelection;
    delete window.__ubbRestoreFilePicker;
  };
  window.__ubbRestoreFilePicker = restore;
  window.__ubbPickerUsed = 'none detected';
  try {
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true, writable: true,
      value: (options = {}) => {
        window.__ubbPickerUsed = 'showOpenFilePicker';
        const selection = new Promise((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.hidden = true;
          input.multiple = Boolean(options.multiple);
          input.accept = (options.types || []).flatMap(type => Object.entries(type.accept || {})
            .flatMap(([mime, extensions]) => [mime, ...(Array.isArray(extensions) ? extensions : [])])).join(',');
          const finish = () => { pending.delete(input); input.remove(); };
          const cancel = () => { finish(); reject(new DOMException('File selection cancelled', 'AbortError')); };
          pending.set(input, cancel);
          input.addEventListener('cancel', cancel, { once: true });
          input.addEventListener('change', () => {
            const files = Array.from(input.files || []);
            finish();
            if (!files.length) { reject(new DOMException('File selection cancelled', 'AbortError')); return; }
            resolve(files.map(file => {
              const handle = {
                kind: 'file', name: file.name,
                getFile: async () => file,
                queryPermission: async () => 'granted', requestPermission: async () => 'granted',
                isSameEntry: async other => other === handle
              };
              return handle;
            }));
          }, { once: true });
          (document.body || document.documentElement).appendChild(input);
          try { input.click(); } catch (error) { finish(); reject(error); }
        });
        window.__ubbPickerSelection = selection.then(() => true, () => false);
        return selection;
      }
    });
    timer = setTimeout(restore, 10000);
  } catch (error) { restore(); throw error; }
  return true;
})()`;

export async function uploadViaFileChooser(message, assertAllowed) {
  await assertAllowed();
  const { tabId, files, x, y, ref } = message;
  const timeoutMs = message.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('File chooser timeout must be 1..10000 ms');
  const mouse = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0;
  if (!mouse && (typeof ref !== 'string' || !/^ubb-\d+$/.test(ref))) throw new Error('File chooser requires center coordinates or an element ref');
  if (activeChoosers.has(tabId)) throw new Error('A file chooser upload is already active for this tab');
  activeChoosers.add(tabId);
  const raw = (method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
  const send = async (method, params = {}) => { await assertAllowed(); return raw(method, params); };
  const evaluate = async (expression, { userGesture = false, cleanup = false } = {}) => {
    const result = await (cleanup ? raw : send)('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page script failed');
    return result?.result?.value;
  };
  let listener;
  let timer;
  let failed = false;
  try {
    await evaluate(installPickerShim);
    await send('Page.enable');
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    const opened = new Promise(resolve => {
      listener = (source, method, params) => {
        if (source.tabId === tabId && method === 'Page.fileChooserOpened') resolve(params);
      };
      chrome.debugger.onEvent.addListener(listener);
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    if (mouse) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else {
      await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(`[data-ubb-ref="${ref}"]`)});
        if (!el) throw new Error('Element ref expired; take a new snapshot');
        el.click();
      })()`, { userGesture: true });
    }
    const chooser = await opened;
    let picker;
    if (!chooser) {
      // The permission can change during the wait. Preserve timeout diagnostics
      // even when that change prevents a guarded diagnostic read.
      try { picker = await evaluate('window.__ubbPickerUsed'); } catch {}
      const used = picker === 'showOpenFilePicker' ? picker : 'showOpenFilePicker shim not triggered / none detected';
      const allowed = !chrome.extension?.isAllowedFileSchemeAccess || await chrome.extension.isAllowedFileSchemeAccess();
      throw new Error(`No file chooser opened within ${timeoutMs / 1000} s (page used: ${used})${allowed ? '' : '. Enable "Allow access to file URLs" for Universal Browser Bridge in chrome://extensions'}`);
    }
    if (chooser.mode === 'selectSingle' && files.length > 1) throw new Error('File chooser allows a single file, but multiple files were supplied');
    if (!['selectSingle', 'selectMultiple'].includes(chooser.mode) || !Number.isInteger(chooser.backendNodeId) || chooser.backendNodeId <= 0) {
      throw new Error('File chooser did not provide a usable file input backendNodeId');
    }
    picker = await evaluate('window.__ubbPickerUsed');
    await send('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId });
    if (picker === 'showOpenFilePicker' && await evaluate('window.__ubbPickerSelection') !== true) {
      throw new Error('File picker selection was cancelled before its change event completed');
    }
    return { uploaded: files.length, files, method: 'chooser', picker: picker === 'showOpenFilePicker' ? picker : 'input' };
  } catch (error) {
    failed = true;
    if (/not allowed/i.test(error.message)) throw new Error(`${error.message}. Enable "Allow access to file URLs" for Universal Browser Bridge in chrome://extensions`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (listener) chrome.debugger.onEvent.removeListener(listener);
    // Cleanup must still run after revocation, navigation or a changed policy.
    // Attempt both operations, and retain the original failure when there is one.
    let cleanupError;
    try { await raw('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (error) { cleanupError = error; }
    try { await evaluate('window.__ubbRestoreFilePicker?.()', { cleanup: true }); } catch (error) { cleanupError ??= error; }
    activeChoosers.delete(tabId);
    if (cleanupError && !failed) throw new Error(`File chooser cleanup failed: ${cleanupError.message}`);
  }
}
