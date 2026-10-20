// Fetch/IO are supported by chrome.debugger. Page fetch cannot read CORS bodies
// or inspect manual redirects; loadNetworkResource follows redirects unchecked,
// and Node fetch would export session cookies. Response interception keeps cookies
// in Chrome and stops each redirect BEFORE the next request is sent. The daemon
// must explicitly continue each validated hop. Only bounded IO chunks cross the
// bridge, so the MV3 worker never holds a large Blob. No new permissions needed.
// https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains
// https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Fetch.pdl
import { MAX_DOWNLOAD_BYTES, DOWNLOAD_CHUNK_BYTES } from './download-policy.js';

const sessions = new Map();
const debuggerEpochs = new Map();
const lateStreams = new Set();
const IDLE_MS = 120000;
const TOTAL_MS = 10 * 60 * 1000;
const REDIRECT_LIMIT = 10;
const withoutFragment = value => { const url = new URL(value); url.hash = ''; return url.href; };

// CDP errors can contain signed URLs. Report the method, never its raw message.
function command(state, method, params = {}, timeoutMs = 15000) {
  if (state.detached || state.epoch !== debuggerEpochs.get(state.tabId)) return Promise.reject(new Error('Download debugger detached'));
  const ownsRequest = method === 'Fetch.failRequest' && params.requestId === state.paused && state.pausedOwned === true;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Download ${method} timed out`)), timeoutMs);
    chrome.debugger.sendCommand({ tabId: state.tabId }, method, params).then(result => {
      clearTimeout(timer);
      // Record resource acknowledgements even after the caller's timeout. The
      // retry must not repeatedly close a handle Chrome already closed.
      if (method === 'IO.close') {
        if (params.handle === state.stream) state.stream = undefined;
        for (const pending of lateStreams) {
          if (pending.state === state && pending.handle === params.handle) {
            clearTimeout(pending.timer);
            lateStreams.delete(pending);
          }
        }
      }
      if (method === 'Fetch.failRequest') state.unidentified.delete(params.requestId);
      if (ownsRequest) state.cancelled = true;
      if (method === 'Fetch.disable') state.enabled = false;
      if (method === 'Runtime.evaluate' && params.expression === state.abortExpression && !result?.exceptionDetails && result?.result?.value === true) state.cancelled = true;
      // A stream handle may arrive after a timeout/cancellation. Still close it.
      if (method === 'Fetch.takeResponseBodyAsStream' && state.closed && result?.stream) {
        closeLateStream(state, result.stream);
      }
      resolve(result);
    }, () => { clearTimeout(timer); reject(new Error(`Download ${method} failed`)); });
  });
}

// A late takeResponseBodyAsStream reply can outlive its transaction. Track the
// handle independently so a failed close is retried without occupying the tab.
function closeLateStream(state, handle) {
  if (state.detached || state.epoch !== debuggerEpochs.get(state.tabId)) return;
  const pending = { state, handle, timer: undefined };
  lateStreams.add(pending);
  const close = () => {
    if (!lateStreams.has(pending)) return;
    if (state.detached || state.epoch !== debuggerEpochs.get(state.tabId)) { lateStreams.delete(pending); return; }
    void command(state, 'IO.close', { handle }, 5000).then(() => lateStreams.delete(pending), () => {
      if (lateStreams.has(pending) && state.epoch === debuggerEpochs.get(state.tabId)) pending.timer = setTimeout(close, 5000);
      else lateStreams.delete(pending);
    });
  };
  close();
}

function touch(state) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { void fail(state, new Error(!state.networkId && state.unidentified.size ? 'Download request could not be identified safely' : 'Download timed out')); }, Math.min(IDLE_MS, Math.max(1, state.deadline - Date.now())));
}
function waitForResponse(state) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Setup can fail before the caller starts awaiting the event promise.
  void promise.catch(() => {});
  state.waiter = { resolve, reject };
  return promise;
}
function deliver(state, result) {
  const waiter = state.waiter;
  state.waiter = undefined;
  waiter?.resolve(result);
}
function forget(state) {
  clearTimeout(state.timer);
  chrome.debugger.onEvent.removeListener(state.listener);
  if (sessions.get(state.tabId) === state) sessions.delete(state.tabId);
  state.finished = true;
}
async function cleanup(state) {
  if (state.detached) { forget(state); return true; }
  if (state.cleanup) return state.cleanup;
  state.closed = true;
  clearTimeout(state.timer);
  state.abortExpression = `(() => { const key = ${JSON.stringify(state.key)}; const controller = globalThis[key];
    if (!controller) return false; controller.abort(); delete globalThis[key]; return true; })()`;
  state.cleanup = (async () => {
    // Cleanup deliberately bypasses policy checks after revocation/disconnect.
    await Promise.allSettled([
      ...(state.stream ? [command(state, 'IO.close', { handle: state.stream }, 5000).then(() => { state.stream = undefined; })] : []),
      ...[...state.unidentified.keys()].map(requestId => command(state, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' }, 5000)),
      ...(state.paused && !state.cancelled ? [command(state, 'Fetch.failRequest', { requestId: state.paused, errorReason: 'Aborted' }, 5000)] : []),
      ...(state.contextId ? [command(state, 'Runtime.evaluate', { contextId: state.contextId,
        expression: state.abortExpression, returnByValue: true }, 5000)
        .then(result => { if (!result?.exceptionDetails && result?.result?.value === true) state.cancelled = true; })] : [])
    ]);
    if (state.detached) { forget(state); return true; }
    // Disabling Fetch resumes pending requests in Chromium. If cancellation
    // cannot be confirmed, KEEP interception and the listener, fail our own
    // chain, and continue unrelated traffic. Never release a rejected redirect.
    let complete = !state.started || state.cancelled;
    if (complete) {
      if (state.enabled) {
        try { await command(state, 'Fetch.disable', {}, 5000); state.enabled = false; }
        catch { complete = false; }
      }
      if (!state.enabled && state.networkEnabled) {
        try {
          await command(state, 'Network.setBypassServiceWorker', { bypass: false }, 5000);
          await command(state, 'Network.disable', {}, 5000);
          state.networkEnabled = false;
        } catch { complete = false; }
      }
      complete = complete && !state.stream && !state.unidentified.size;
    }
    if (state.detached || complete) { forget(state); return true; }
    // An incomplete cleanup quarantines this tab's transaction. Commands report
    // that state; retry every 5 s until Chrome confirms cleanup or detaches.
    // Each CDP attempt is bounded to 5 s. A new download cannot replace it.
    state.timer = setTimeout(() => { state.cleanup = undefined; void cleanup(state); }, 5000);
    return false;
  })();
  return state.cleanup;
}
async function fail(state, error) {
  state.error ??= error;
  await cleanup(state);
  state.waiter?.reject(state.error);
  state.waiter = undefined;
}
async function check(state, url = state.url, redirect = state.previousId !== undefined) {
  if (state.closed) throw state.error || new Error('Download session expired');
  if (Date.now() >= state.deadline) throw new Error('Download timed out');
  const result = await state.assertAllowed(url, redirect);
  if (state.closed) throw state.error || new Error('Download session expired');
  return result;
}
async function paused(state, event) {
  // The first response must match the exact source. Later responses must also
  // belong to the same redirect chain (URL matching alone can capture page IO).
  if (!state.networkId && event.request?.url === state.url) {
    // The tagged Network event may arrive later. Hold ambiguous same-source
    // responses briefly; once identified, unrelated requests continue. Missing
    // identity must never cause our own redirect to be treated as unrelated.
    state.unidentified.set(event.requestId, event);
    if (state.closed) {
      await command(state, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }, 5000);
      state.unidentified.delete(event.requestId);
    } else if (state.unidentified.size > 256) throw new Error('Too many unidentified download responses');
    return;
  }
  const related = event.request?.url === state.url && (state.networkId && event.networkId === state.networkId
    || state.previousId !== undefined && event.redirectedRequestId === state.previousId);
  if (related && state.closed) {
    state.paused = event.requestId;
    state.pausedOwned = true;
    await command(state, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }, 5000);
    state.cancelled = true;
    return;
  }
  if (!related || state.stream || state.paused) {
    await command(state, 'Fetch.continueRequest', { requestId: event.requestId });
    return;
  }
  state.paused = event.requestId;
  state.pausedOwned = true;
  await check(state);
  touch(state);
  if (event.responseErrorReason) throw new Error('Download request failed in Chrome');
  const status = event.responseStatusCode;
  const headers = event.responseHeaders || [];
  const header = name => headers.find(item => item.name.toLowerCase() === name)?.value;
  const location = header('location');
  if ([301, 302, 303, 307, 308].includes(status) && location) {
    if (++state.redirects > REDIRECT_LIMIT) throw new Error('Download redirect limit exceeded (10 hops)');
    let next;
    try { next = new URL(location, state.url).href; } catch { throw new Error('Invalid download redirect URL'); }
    state.nextUrl = withoutFragment(await check(state, next, true));
    // This response is still paused. The daemon independently checks this URL
    // against its synced policy before downloadContinue is permitted to resume it.
    deliver(state, { redirectUrl: state.nextUrl });
    return;
  }
  if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`Download fetch failed (HTTP ${Number.isInteger(status) ? status : 'unknown'})`);
  const length = Number(header('content-length'));
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('Download exceeds the 500 MB limit');
  const result = await command(state, 'Fetch.takeResponseBodyAsStream', { requestId: state.paused });
  if (state.closed) throw state.error || new Error('Download session expired');
  if (typeof result?.stream !== 'string' || !result.stream) throw new Error('Chrome did not return a download stream');
  state.stream = result.stream;
  deliver(state, { mimeType: header('content-type') || 'application/octet-stream' });
}

export async function networkDownload(message, assertAllowed) {
  const { action, tabId, label, downloadKey } = message;
  let state = sessions.get(tabId);
  if (action === 'downloadCancel') {
    if (!state) return { closed: true };
    if (state.label !== label || state.key !== downloadKey) throw new Error('Download session is owned by another request');
    await fail(state, new Error('Download cancelled'));
    if (!state.finished) throw new Error('Download cleanup incomplete; interception retained until cancellation can be confirmed');
    return { closed: true };
  }
  if (action === 'downloadStart') {
    if (state) throw new Error('A network download is already active for this tab');
    if (typeof downloadKey !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(downloadKey)) throw new Error('Invalid download session key');
    const url = await assertAllowed(message.url, false);
    if (!/^https?:/.test(url)) throw new Error('Network downloads require an HTTP(S) source');
    if (sessions.has(tabId)) throw new Error('A network download is already active for this tab');
    if (!debuggerEpochs.has(tabId)) debuggerEpochs.set(tabId, 0);
    state = { tabId, label, epoch: debuggerEpochs.get(tabId), key: downloadKey, url: withoutFragment(url), assertAllowed, unidentified: new Map(), redirects: 0, bytes: 0, deadline: Date.now() + TOTAL_MS };
    sessions.set(tabId, state);
    state.initiator = 'ubb-download-' + state.key;
    state.listener = (source, method, event) => {
      if (source.tabId !== tabId || source.sessionId) return;
      // Network metadata stays local to the extension. An exact URL alone is
      // insufficient: a simultaneous page fetch could steal the body stream
      // and let our actual redirect chain proceed without validation.
      if (method === 'Network.requestWillBeSent' && state.networkId === undefined && event.request?.url === state.url) {
        for (let stack = event.initiator?.stack; stack; stack = stack.parent) {
          if (stack.callFrames?.some(frame => frame.url === state.initiator)) {
            state.networkId = event.requestId; // Set synchronously, before Fetch's response event.
            break;
          }
        }
        if (state.networkId) {
          const waiting = [...state.unidentified.values()];
          state.unidentified.clear();
          for (const response of waiting) void paused(state, response).catch(error => fail(state, error));
        }
      }
      if ((method === 'Network.loadingFailed' || method === 'Network.loadingFinished') && state.networkId && event.requestId === state.networkId) {
        state.cancelled = true; // Terminal evidence survives navigation/context destruction.
        if (!state.closed && method === 'Network.loadingFailed') void fail(state, new Error('Download request failed in Chrome'));
      }
      if (method === 'Fetch.requestPaused') void paused(state, event).catch(error => fail(state, error));
    };
    chrome.debugger.onEvent.addListener(state.listener);
    touch(state);
    const response = waitForResponse(state);
    try {
      const setup = async (method, params = {}) => {
        await check(state);
        const result = await command(state, method, params);
        await check(state); // Stop late setup replies from re-enabling after cleanup.
        return result;
      };
      await check(state);
      // A controlling service worker could hide forwarding and redirects in a
      // different target. Bypass it for this tab transaction, restore on cleanup.
      // Network is otherwise unused by this extension; the tab lease serializes
      // download/upload actions, so these scoped settings have no competing owner.
      state.networkEnabled = true;
      await setup('Network.enable');
      await setup('Network.setBypassServiceWorker', { bypass: true });
      // Scope interception to page fetch requests for HTTP(S), not navigation,
      // images, file choosers, or blob/data. No other code uses the Fetch domain.
      state.enabled = true; // Also attempt disable if enable times out.
      await setup('Fetch.enable', { patterns: [
        { urlPattern: 'http://*', resourceType: 'Fetch', requestStage: 'Response' },
        { urlPattern: 'https://*', resourceType: 'Fetch', requestStage: 'Response' }
      ] });
      const tree = await setup('Page.getFrameTree');
      const world = await setup('Page.createIsolatedWorld', { frameId: tree?.frameTree?.frame?.id, worldName: 'ubb-download' });
      if (!Number.isInteger(world?.executionContextId)) throw new Error('Chrome did not return a download execution context');
      state.contextId = world.executionContextId;
      await check(state);
      // Isolated world avoids page overrides of fetch/AbortController, while
      // retaining Chrome's own cookie and credential handling. CSP/cookie policy
      // still applies. Never await fetch here: its response is deliberately held.
      state.started = true;
      const result = await command(state, 'Runtime.evaluate', { contextId: state.contextId, returnByValue: true, userGesture: true,
        expression: `(() => {
          const controller = new AbortController();
          const key = ${JSON.stringify(state.key)};
          // Retain the controller even if fetch rejects before a Network event,
          // so cleanup can still prove cancellation and remove this marker.
          globalThis[key] = controller;
          const timer = setTimeout(() => controller.abort(), ${TOTAL_MS});
          fetch(${JSON.stringify(state.url)}, { mode: 'no-cors', credentials: 'include', redirect: 'follow', cache: 'no-store', signal: controller.signal })
            .catch(() => {}).finally(() => clearTimeout(timer));
          return true;
        })()\n//# sourceURL=${state.initiator}` });
      if (result?.exceptionDetails) throw new Error('Download request failed in Chrome');
      return await response;
    } catch (error) { await fail(state, error); throw error; }
  }
  if (!state || state.key !== downloadKey || state.label !== label) throw new Error('Download session expired or is not owned by this request');
  if (state.busy) throw new Error('A download operation is already active');
  state.busy = true;
  try {
    await check(state);
    touch(state);
    if (action === 'downloadContinue') {
      if (!state.nextUrl || !state.paused || state.stream) throw new Error('Download has no paused redirect');
      await check(state, state.nextUrl, true);
      const requestId = state.paused;
      state.url = state.nextUrl;
      state.nextUrl = undefined;
      state.previousId = requestId;
      state.paused = undefined;
      const response = waitForResponse(state);
      await command(state, 'Fetch.continueRequest', { requestId });
      return await response;
    }
    if (action !== 'downloadRead' || !state.stream) throw new Error('Download stream is not ready');
    const result = await command(state, 'IO.read', { handle: state.stream, size: DOWNLOAD_CHUNK_BYTES });
    if (!result || typeof result.data !== 'string' || typeof result.eof !== 'boolean') throw new Error('Invalid download IO chunk');
    if (result.data.length > DOWNLOAD_CHUNK_BYTES * 2) throw new Error('Invalid download IO chunk length');
    const length = result.base64Encoded ? atob(result.data).length : new TextEncoder().encode(result.data).length;
    if (length > DOWNLOAD_CHUNK_BYTES) throw new Error('Invalid download IO chunk length');
    state.bytes += length;
    if (state.bytes > MAX_DOWNLOAD_BYTES) throw new Error('Download exceeds the 500 MB limit');
    await check(state);
    return { data: result.data, base64Encoded: result.base64Encoded === true, eof: result.eof };
  } catch (error) { await fail(state, error); throw error; }
  finally { state.busy = false; }
}

export async function cancelNetworkDownloads(tabId, detached = false) {
  if (detached) {
    for (const id of tabId === undefined ? debuggerEpochs.keys() : [tabId]) debuggerEpochs.set(id, (debuggerEpochs.get(id) || 0) + 1);
    for (const pending of lateStreams) {
      if (tabId === undefined || pending.state.tabId === tabId) {
        pending.state.detached = true;
        clearTimeout(pending.timer);
        lateStreams.delete(pending);
      }
    }
  }
  await Promise.allSettled([...sessions.values()].filter(state => tabId === undefined || state.tabId === tabId)
    .map(state => { state.detached ||= detached; return fail(state, new Error('Download cancelled')); }));
}
