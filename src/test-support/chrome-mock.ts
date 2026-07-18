// A minimal mock of the chrome.* extension API surface that
// extension/background.js touches, with per-call artificial async delay so
// tests can force specific realistic IPC-latency interleavings without a
// real Chrome. Used to reproduce races between an API call's own promise
// chain and the browser events that call triggers.
export type ChromeMockDelays = Partial<{
  tabsGet: number;
  tabsCreate: number;
  tabsGroup: number;
  tabGroupsGet: number;
  tabGroupsUpdate: number;
  debuggerAttach: number;
  debuggerDetach: number;
  badge: number;
}>;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MockTab = { id: number; windowId: number; url: string; title: string; active: boolean; groupId: number };
type MockGroup = { id: number; title: string; color: string; collapsed: boolean; windowId: number };

export function createChromeMock(options: { delays?: ChromeMockDelays } = {}) {
  const delays = options.delays ?? {};
  const d = (name: keyof ChromeMockDelays, fallback: number) => delays[name] ?? fallback;

  const tabsById = new Map<number, MockTab>();
  const groupsById = new Map<number, MockGroup>();
  const windowsById = new Map<number, { id: number; focused: boolean; tabs: MockTab[] }>();
  let nextTabId = 100;
  let nextGroupId = 1;
  let nextWindowId = 1;

  const tabsOnUpdated: Array<(tabId: number, changeInfo: { groupId?: number }, tab: MockTab) => void> = [];
  const tabsOnRemoved: Array<(tabId: number) => void> = [];
  const tabGroupsOnUpdated: Array<(group: MockGroup) => void> = [];

  const sessionStore = new Map<string, unknown>();
  const localStore = new Map<string, unknown>();

  // chrome.storage.*.get accepts a string key, an array of keys, or an
  // object of {key: defaultValue} -- background.js uses all three forms.
  function readStorage(store: Map<string, unknown>, query: unknown): Record<string, unknown> {
    if (typeof query === "string") return { [query]: store.get(query) };
    if (Array.isArray(query)) {
      const out: Record<string, unknown> = {};
      for (const k of query) out[k] = store.get(k);
      return out;
    }
    const defaults = query as Record<string, unknown>;
    const out: Record<string, unknown> = { ...defaults };
    for (const k of Object.keys(defaults)) if (store.has(k)) out[k] = store.get(k);
    return out;
  }

  function makeTab({ windowId, url, active }: { windowId: number; url: string; active: boolean }): MockTab {
    const id = nextTabId++;
    const tab: MockTab = { id, windowId, url, title: "New Tab", active, groupId: -1 };
    tabsById.set(id, tab);
    return tab;
  }

  const chrome = {
    storage: {
      local: {
        get: async (query: unknown) => readStorage(localStore, query),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) localStore.set(k, v);
        }
      },
      session: {
        get: async (query: unknown) => readStorage(sessionStore, query),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
        },
        remove: async (key: string) => {
          sessionStore.delete(key);
        }
      },
      onChanged: { addListener: () => {} }
    },
    windows: {
      get: async (id: number) => {
        if (!windowsById.has(id)) throw new Error(`No window ${id}`);
        return { ...windowsById.get(id)! };
      },
      create: async ({ url, focused }: { url: string; focused: boolean }) => {
        const id = nextWindowId++;
        const tab = makeTab({ windowId: id, url, active: true });
        const win = { id, focused: Boolean(focused), tabs: [{ ...tab }] };
        windowsById.set(id, win);
        return win;
      },
      remove: async (id: number) => {
        windowsById.delete(id);
      },
      onRemoved: { addListener: () => {} }
    },
    tabs: {
      create: async ({ windowId, url, active }: { windowId: number; url: string; active: boolean }) => {
        await wait(d("tabsCreate", 0));
        return { ...makeTab({ windowId, url, active }) };
      },
      get: async (id: number) => {
        await wait(d("tabsGet", 0));
        if (!tabsById.has(id)) throw new Error(`No tab ${id}`);
        return { ...tabsById.get(id)! };
      },
      remove: async (id: number) => {
        tabsById.delete(id);
        for (const fn of tabsOnRemoved) fn(id);
      },
      group: async ({
        tabIds,
        groupId,
        createProperties
      }: {
        tabIds: number[];
        groupId?: number;
        createProperties?: { windowId: number };
      }) => {
        const tabId = tabIds[0]!;
        const tab = tabsById.get(tabId)!;
        const gid = groupId ?? nextGroupId++;
        if (!groupsById.has(gid)) {
          groupsById.set(gid, {
            id: gid,
            title: "",
            color: "grey",
            collapsed: false,
            windowId: createProperties?.windowId ?? tab.windowId
          });
        }
        await wait(d("tabsGroup", 0));
        tab.groupId = gid;
        // Real Chrome dispatches tabs.onUpdated over its own event channel,
        // not strictly ordered after this call's own promise settles.
        queueMicrotask(() => {
          for (const fn of tabsOnUpdated) fn(tabId, { groupId: gid }, { ...tab });
        });
        return gid;
      },
      ungroup: async (tabId: number) => {
        const tab = tabsById.get(tabId);
        if (tab) tab.groupId = -1;
      },
      onUpdated: { addListener: (fn: (typeof tabsOnUpdated)[number]) => tabsOnUpdated.push(fn) },
      onRemoved: { addListener: (fn: (typeof tabsOnRemoved)[number]) => tabsOnRemoved.push(fn) },
      query: async ({ groupId }: { groupId: number }) =>
        [...tabsById.values()].filter((t) => t.groupId === groupId).map((t) => ({ ...t }))
    },
    tabGroups: {
      query: async ({ title, windowId }: { title: string; windowId: number }) =>
        [...groupsById.values()].filter((g) => g.title === title && g.windowId === windowId).map((g) => ({ ...g })),
      get: async (id: number) => {
        await wait(d("tabGroupsGet", 0));
        return { ...groupsById.get(id)! };
      },
      update: async (id: number, changes: Partial<MockGroup>) => {
        await wait(d("tabGroupsUpdate", 0));
        const group = groupsById.get(id)!;
        Object.assign(group, changes);
        for (const fn of tabGroupsOnUpdated) fn({ ...group });
        return { ...group };
      },
      onUpdated: { addListener: (fn: (typeof tabGroupsOnUpdated)[number]) => tabGroupsOnUpdated.push(fn) }
    },
    debugger: {
      attach: async () => {
        await wait(d("debuggerAttach", 0));
      },
      detach: async () => {
        await wait(d("debuggerDetach", 0));
      },
      sendCommand: async () => ({}),
      onDetach: { addListener: () => {} }
    },
    action: {
      setBadgeText: async () => {
        await wait(d("badge", 0));
      },
      setBadgeBackgroundColor: async () => {
        await wait(d("badge", 0));
      },
      onClicked: { addListener: () => {} }
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://faketestid/${path}`,
      onMessage: { addListener: () => {} }
    }
  };

  // Simulates a human renaming the group via the real Chrome tab-strip UI:
  // unlike chrome.tabGroups.update (which the extension itself calls), this
  // mutates the group and fires tabGroups.onUpdated without going through
  // the extension's own code, exactly like a Chrome-originated event would.
  function simulateGroupRename(groupId: number, title: string): void {
    const group = groupsById.get(groupId);
    if (!group) throw new Error(`No group ${groupId}`);
    group.title = title;
    for (const fn of tabGroupsOnUpdated) fn({ ...group });
  }

  return { chrome, simulateGroupRename };
}
