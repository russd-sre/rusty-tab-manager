const RECONCILE_DELAY_MS = 100;
const GROUP_TITLE_MAX_LEN = 8;
const NONE_GROUP_ID = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

const reconcileTimers = new Map();
const collapseOverrides = new Map();
let suppressReconcile = false;

function truncateDomain(domain) {
  const prefix = domain.split(".")[0];
  return prefix.length > GROUP_TITLE_MAX_LEN
    ? prefix.substring(0, GROUP_TITLE_MAX_LEN)
    : prefix;
}

function getSecondLevelDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const parts = hostname.split(".").filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(-2).join(".");
    }
    return hostname;
  } catch {
    return null;
  }
}

function normalizeDomainPattern(value) {
  if (!value) return null;

  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\//, "");
  normalized = normalized.replace(/^\*\./, "");

  const slashIndex = normalized.indexOf("/");
  if (slashIndex !== -1) {
    normalized = normalized.slice(0, slashIndex);
  }

  if (!normalized) return null;

  const parts = normalized.split(".").filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }

  return normalized;
}

function normalizeRules(rules) {
  const normalizedRules = {};

  for (const [groupName, domains] of Object.entries(rules || {})) {
    const cleanGroupName = groupName.trim();
    if (!cleanGroupName) continue;

    const cleanDomains = [
      ...new Set((domains || []).map(normalizeDomainPattern).filter(Boolean))
    ];
    if (cleanDomains.length > 0) {
      normalizedRules[cleanGroupName] = cleanDomains;
    }
  }

  return normalizedRules;
}

async function getRules() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["domainRules"], (result) => {
      resolve(normalizeRules(result.domainRules || {}));
    });
  });
}

async function saveRules(rules) {
  const normalizedRules = normalizeRules(rules);
  return new Promise((resolve) => {
    chrome.storage.sync.set({ domainRules: normalizedRules }, resolve);
  });
}

function isManageableTab(tab) {
  return Boolean(
    tab &&
      !tab.pinned &&
      tab.url &&
      tab.url !== "about:blank" &&
      !tab.url.startsWith("chrome://") &&
      !tab.url.startsWith("about:")
  );
}

function getManagedDomain(tab) {
  if (!isManageableTab(tab)) return null;
  return getSecondLevelDomain(tab.url);
}

function findGroupForDomain(domain, rules) {
  for (const [groupName, domains] of Object.entries(rules)) {
    if (domains.includes(domain)) {
      return groupName;
    }
  }
  return null;
}

function getGroupNameForDomain(domain, rules) {
  return findGroupForDomain(domain, rules) || truncateDomain(domain);
}

function getDesiredGroupName(tab, rules) {
  const domain = getManagedDomain(tab);
  if (!domain) return null;
  return getGroupNameForDomain(domain, rules);
}

function scheduleReconcile(windowId) {
  if (suppressReconcile) return;
  const key = typeof windowId === "number" ? String(windowId) : "all";
  const previousTimer = reconcileTimers.get(key);
  if (previousTimer) {
    clearTimeout(previousTimer);
  }

  const timer = setTimeout(async () => {
    reconcileTimers.delete(key);
    try {
      if (typeof windowId === "number") {
        await reconcileWindow(windowId);
      } else {
        await reconcileAllWindows();
      }
    } catch (err) {
      console.warn("reconcile failed:", err);
    }
  }, RECONCILE_DELAY_MS);

  reconcileTimers.set(key, timer);
}

async function getWindowGroups(windowId) {
  return chrome.tabGroups.query({ windowId });
}

async function ungroupExcludedTabs(tabs) {
  for (const tab of tabs) {
    if (tab.groupId === NONE_GROUP_ID) continue;
    if (isManageableTab(tab)) continue;

    try {
      await chrome.tabs.ungroup(tab.id);
    } catch (err) {
      console.warn("ungroup failed for tab", tab.id, err);
    }
  }
}

async function ensureWindowGroups(windowId, tabs, rules) {
  const audioGroupId = await getAudioGroupId(windowId);
  const buckets = new Map();

  for (const tab of tabs) {
    if (audioGroupId && tab.groupId === audioGroupId) continue;

    const groupName = getDesiredGroupName(tab, rules);
    if (!groupName) continue;

    if (!buckets.has(groupName)) {
      buckets.set(groupName, []);
    }
    buckets.get(groupName).push(tab);
  }

  let groups = await getWindowGroups(windowId);
  const reservedGroupIds = new Set();

  for (const [groupName, bucketTabs] of buckets.entries()) {
    let targetGroup = groups.find(
      (group) =>
        group.title === groupName && !reservedGroupIds.has(group.id)
    );

    if (!targetGroup) {
      const existingGroupedTab = bucketTabs.find((tab) => {
        if (tab.groupId === NONE_GROUP_ID) return false;
        if (reservedGroupIds.has(tab.groupId)) return false;
        const group = groups.find((g) => g.id === tab.groupId);
        if (group && buckets.has(group.title) && group.title !== groupName) {
          return false;
        }
        return true;
      });
      if (existingGroupedTab) {
        try {
          await chrome.tabGroups.update(existingGroupedTab.groupId, {
            title: groupName,
            collapsed: false,
          });
          targetGroup = await chrome.tabGroups.get(existingGroupedTab.groupId);
        } catch (err) {
          console.warn("failed to update existing group:", err);
        }
      }
    }

    if (!targetGroup) {
      try {
        const groupId = await chrome.tabs.group({
          tabIds: [bucketTabs[0].id],
        });
        await chrome.tabGroups.update(groupId, {
          title: groupName,
          collapsed: false,
        });
        targetGroup = await chrome.tabGroups.get(groupId);
      } catch (err) {
        console.warn("failed to create group:", err);
        continue;
      }
    }

    reservedGroupIds.add(targetGroup.id);

    const tabIdsToMove = bucketTabs
      .filter((tab) => tab.groupId !== targetGroup.id)
      .map((tab) => tab.id);

    if (tabIdsToMove.length > 0) {
      try {
        await chrome.tabs.group({
          tabIds: tabIdsToMove,
          groupId: targetGroup.id,
        });
      } catch (err) {
        console.warn("failed to move tabs to group:", err);
      }
    }
  }

  return getWindowGroups(windowId);
}

async function cleanupWindowGroups(windowId, tabs, rules) {
  const groups = await getWindowGroups(windowId);

  for (const group of groups) {
    if (group.title === "audio") continue;

    const groupTabs = tabs.filter((tab) => tab.groupId === group.id);
    if (groupTabs.length === 0) continue;

    const desiredNames = [
      ...new Set(
        groupTabs.map((tab) => getDesiredGroupName(tab, rules)).filter(Boolean)
      ),
    ];

    if (desiredNames.length !== 1) continue;

    const desiredTitle = desiredNames[0];
    if (group.title === desiredTitle) continue;

    try {
      await chrome.tabGroups.update(group.id, {
        title: desiredTitle,
        collapsed: false,
      });
    } catch (err) {
      console.warn("failed to rename group:", err);
    }
  }
}

async function sortWindowGroups(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const groups = (await getWindowGroups(windowId)).sort((left, right) => {
    return (left.title || "").localeCompare(right.title || "");
  });

  let insertIndex = tabs.filter((tab) => tab.pinned).length;

  for (const group of groups) {
    const groupTabs = tabs
      .filter((tab) => tab.groupId === group.id)
      .sort((left, right) => left.index - right.index);

    if (groupTabs.length === 0) continue;

    try {
      await chrome.tabs.move(
        groupTabs.map((tab) => tab.id),
        { index: insertIndex }
      );
      insertIndex += groupTabs.length;
    } catch (err) {
      console.warn("failed to sort group tabs:", err);
    }
  }
}

async function syncCollapsedState(windowId) {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    getWindowGroups(windowId),
  ]);

  const override = collapseOverrides.get(windowId);

  if (override === "all-expanded") {
    for (const group of groups) {
      if (!group.collapsed) continue;
      try {
        await chrome.tabGroups.update(group.id, { collapsed: false });
      } catch (err) {
        console.warn("failed to expand group:", err);
      }
    }
    return;
  }

  const activeTab = tabs.find((tab) => tab.active);
  const activeGroupId =
    activeTab && isManageableTab(activeTab)
      ? activeTab.groupId
      : NONE_GROUP_ID;

  for (const group of groups) {
    const shouldCollapse = group.id !== activeGroupId;
    if (group.collapsed === shouldCollapse) continue;

    try {
      await chrome.tabGroups.update(group.id, { collapsed: shouldCollapse });
    } catch (err) {
      console.warn("failed to update collapse state:", err);
    }
  }
}

async function expandAllGroups(windowId) {
  const groups = await getWindowGroups(windowId);
  for (const group of groups) {
    if (!group.collapsed) continue;
    try {
      await chrome.tabGroups.update(group.id, { collapsed: false });
    } catch (err) {
      console.warn("failed to expand group:", err);
    }
  }
}

async function reconcileWindow(windowId, providedRules) {
  const rules = providedRules || (await getRules());
  const tabs = await chrome.tabs.query({ windowId });

  await ungroupExcludedTabs(tabs);
  await ensureWindowGroups(windowId, tabs, rules);
  await cleanupWindowGroups(windowId, tabs, rules);
  await sortWindowGroups(windowId);
  await syncCollapsedState(windowId);
}

async function reconcileAllWindows(providedRules) {
  const rules = providedRules || (await getRules());
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });

  for (const win of windows) {
    await reconcileWindow(win.id, rules);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  scheduleReconcile(tab.windowId);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  scheduleReconcile(removeInfo.windowId);
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  scheduleReconcile(moveInfo.windowId);
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  scheduleReconcile(attachInfo.newWindowId);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  scheduleReconcile(detachInfo.oldWindowId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId === NONE_GROUP_ID) {
    scheduleReconcile(tab.windowId);
    return;
  }
  if (changeInfo.url === undefined && changeInfo.pinned === undefined) {
    return;
  }
  scheduleReconcile(tab.windowId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  collapseOverrides.delete(activeInfo.windowId);
  scheduleReconcile(activeInfo.windowId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    scheduleReconcile(windowId);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleReconcile();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleReconcile();
});

async function getAudioGroupId(windowId) {
  const groups = await getWindowGroups(windowId);
  const audioGroup = groups.find((g) => g.title === "audio");
  return audioGroup ? audioGroup.id : null;
}

function cancelPendingReconciles() {
  for (const [key, timer] of reconcileTimers) {
    clearTimeout(timer);
  }
  reconcileTimers.clear();
}

async function groupAudioTabs(windowId) {
  suppressReconcile = true;
  try {
    const audibleTabs = await chrome.tabs.query({ windowId, audible: true });
    if (audibleTabs.length === 0) return;

    const groups = await getWindowGroups(windowId);
    const existingAudioGroup = groups.find((g) => g.title === "audio");

    const tabIds = audibleTabs.map((tab) => tab.id);

    if (existingAudioGroup) {
      await chrome.tabs.group({ tabIds, groupId: existingAudioGroup.id });
      await chrome.tabGroups.update(existingAudioGroup.id, { collapsed: false });
    } else {
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, {
        title: "audio",
        color: "yellow",
        collapsed: false,
      });
    }

    await sortWindowGroups(windowId);
  } finally {
    suppressReconcile = false;
    cancelPendingReconciles();
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "expand-all-groups" && command !== "group-audio-tabs") return;

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const windowId = activeTab
      ? activeTab.windowId
      : (await chrome.windows.getLastFocused()).id;

    cancelPendingReconciles();

    if (command === "group-audio-tabs") {
      await groupAudioTabs(windowId);
    } else {
      collapseOverrides.set(windowId, "all-expanded");
      await expandAllGroups(windowId);
    }
  } catch (err) {
    console.warn(command + " command failed:", err);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getRules") {
    getRules().then(sendResponse);
    return true;
  }

  if (request.action === "saveRules") {
    saveRules(request.rules).then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.action === "reconcileGroups") {
    const rules = normalizeRules(request.rules || {});
    reconcileAllWindows(rules).then(() => sendResponse({ success: true }));
    return true;
  }

  return false;
});
