const GROUP_PREFIX = "";
const COMMON_TLDS = ['com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'ai', 'app', 'dev', 'info', 'biz'];
const DEFAULT_RULES = {};

function truncateDomain(domain) {
  const parts = domain.split('.');
  if (parts.length >= 2) {
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (COMMON_TLDS.includes(tld)) {
      if (sld.length <= 8) return sld;
      return sld.substring(0, 4) + sld.substring(sld.length - 4);
    }
  }
  if (domain.length <= 8) return domain;
  return domain.substring(0, 4) + domain.substring(domain.length - 4);
}

function getSecondLevelDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return parts.slice(-2).join('.');
    }
    return hostname;
  } catch {
    return null;
  }
}

function normalizeDomainPattern(value) {
  if (!value) return null;

  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\//, '');
  normalized = normalized.replace(/^\*\./, '');

  const slashIndex = normalized.indexOf('/');
  if (slashIndex !== -1) {
    normalized = normalized.slice(0, slashIndex);
  }

  if (!normalized) return null;

  const parts = normalized.split('.').filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return normalized;
}

function normalizeRules(rules) {
  const normalizedRules = {};

  for (const [groupName, domains] of Object.entries(rules || {})) {
    const cleanGroupName = groupName.trim();
    if (!cleanGroupName) continue;

    const cleanDomains = [...new Set((domains || [])
      .map(normalizeDomainPattern)
      .filter(Boolean))];

    if (cleanDomains.length > 0) {
      normalizedRules[cleanGroupName] = cleanDomains;
    }
  }

  return normalizedRules;
}

async function getRules() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['domainRules'], (result) => {
      resolve(normalizeRules(result.domainRules || DEFAULT_RULES));
    });
  });
}

async function saveRules(rules) {
  const normalizedRules = normalizeRules(rules);

  return new Promise((resolve) => {
    chrome.storage.sync.set({ domainRules: normalizedRules }, resolve);
  });
}

function findGroupForDomain(domain, rules) {
  for (const [groupName, domains] of Object.entries(rules)) {
    if (domains.includes(domain)) {
      return groupName;
    }
  }
  return null;
}

function getAllDomainsForGroup(rules) {
  const domainToGroup = new Map();
  for (const [groupName, domains] of Object.entries(rules)) {
    for (const domain of domains) {
      domainToGroup.set(domain, groupName);
    }
  }
  return domainToGroup;
}

function getGroupNameForDomain(domain, rules) {
  return findGroupForDomain(domain, rules) || truncateDomain(domain);
}

function isManageableTab(tab) {
  return Boolean(
    tab &&
    !tab.pinned &&
    tab.url &&
    tab.url !== 'about:blank' &&
    !tab.url.startsWith('chrome://') &&
    !tab.url.startsWith('about:')
  );
}

function getManagedDomain(tab) {
  if (!isManageableTab(tab)) return null;
  return getSecondLevelDomain(tab.url);
}

function getBucketKey(windowId, groupName) {
  return `${windowId}:${groupName}`;
}

async function getOrCreateGroup(domain, rules, windowId) {
  const groupName = getGroupNameForDomain(domain, rules);
  const groups = await chrome.tabGroups.query({});
  const existing = groups.find(
    (group) => group.title === GROUP_PREFIX + groupName && group.windowId === windowId
  );
  if (existing) return existing;

  const tabs = await chrome.tabs.query({});
  const domainTabs = tabs.filter((tab) => {
    const tabDomain = getManagedDomain(tab);
    return (
      tab.windowId === windowId &&
      tabDomain &&
      getGroupNameForDomain(tabDomain, rules) === groupName
    );
  });

  if (domainTabs.length >= 1) {
    const existingGroupedTab = domainTabs.find(
      (tab) => tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
    );

    if (existingGroupedTab) {
      await chrome.tabGroups.update(existingGroupedTab.groupId, {
        title: GROUP_PREFIX + groupName,
        collapsed: false
      });

      const tabIdsToMove = domainTabs
        .filter((tab) => tab.groupId !== existingGroupedTab.groupId)
        .map((tab) => tab.id);

      if (tabIdsToMove.length > 0) {
        await chrome.tabs.group({
          tabIds: tabIdsToMove,
          groupId: existingGroupedTab.groupId
        });
      }

      return chrome.tabGroups.get(existingGroupedTab.groupId);
    }

    const groupId = await chrome.tabs.group({ tabIds: domainTabs.map(t => t.id) });
    await chrome.tabGroups.update(groupId, {
      title: GROUP_PREFIX + groupName,
      collapsed: false
    });
    return chrome.tabGroups.get(groupId);
  }

  return null;
}

async function collapseOtherGroups(activeGroupId) {
  try {
    const groups = await chrome.tabGroups.query({});
    const toCollapse = groups.filter(g =>
      g &&
      typeof g.id !== 'undefined' &&
      g.id !== activeGroupId &&
      g.collapsed !== true &&
      g.collapsed !== undefined
    );
    await Promise.all(toCollapse.map(g => chrome.tabGroups.update(g.id, { collapsed: true })));
  } catch (e) {}
}

async function sortAllGroups() {
  try {
    const groups = await chrome.tabGroups.query({});
    const sorted = groups.sort((a, b) => {
      const titleA = a && a.title ? a.title : '';
      const titleB = b && b.title ? b.title : '';
      return titleA.localeCompare(titleB);
    });
    for (const group of sorted) {
      if (!group || !group.id) continue;
      try {
        const tabs = await chrome.tabs.query({ groupId: group.id });
        for (let j = 0; j < tabs.length; j++) {
          try {
            await chrome.tabs.move(tabs[j].id, { index: -1 });
          } catch {}
        }
      } catch {}
    }
  } catch {}
}

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab || !tab.url || tab.url === 'about:blank' || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;
  if (tab.pinned) return;
  const domain = getSecondLevelDomain(tab.url);
  if (!domain) return;

  const rules = await getRules();
  const group = await getOrCreateGroup(domain, rules, tab.windowId);
  if (group) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
    } catch {}
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.pinned) return;
  if (changeInfo.url) {
    const domain = getSecondLevelDomain(tab.url);
    if (!domain) return;

    const rules = await getRules();
    const groups = await chrome.tabGroups.query({});
    const groupName = getGroupNameForDomain(domain, rules);
    const existingGroup = groups.find(
      (group) => group.title === GROUP_PREFIX + groupName && group.windowId === tab.windowId
    );

    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || !existingGroup) {
      const group = await getOrCreateGroup(domain, rules, tab.windowId);
      if (group && tab.groupId !== group.id) {
        try {
          await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
        } catch {}
      }
    }
  }
});

chrome.tabs.onMoved.addListener(async (tabInfo) => {
  if (!tabInfo || !tabInfo.tabId) return;
  try {
    const tab = await chrome.tabs.get(tabInfo.tabId);
    if (!tab || !tab.url || tab.url === 'about:blank' || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;
    if (tab.pinned) return;
    const domain = getSecondLevelDomain(tab.url);
    if (!domain) return;
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    const rules = await getRules();
    const group = await getOrCreateGroup(domain, rules, tab.windowId);
    if (group) {
      try {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
      } catch {}
    }
  } catch {}
});

chrome.tabGroups.onCreated.addListener(async (group) => {
  if (group && group.id) {
    try {
      await chrome.tabGroups.update(group.id, { collapsed: false });
    } catch {}
  }
  try {
    await sortAllGroups();
  } catch {}
});

chrome.tabGroups.onUpdated.addListener(async (group, changeInfo) => {
  if (changeInfo && changeInfo.collapsed === false) {
    await collapseOtherGroups(group.id);
  }
  if (changeInfo && changeInfo.title) {
    await sortAllGroups();
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!activeInfo || !activeInfo.tabId) return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      await collapseOtherGroups(tab.groupId);
    }
  } catch {}
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    const domainMap = {};
    const rules = await getRules();

    for (const tab of tabs) {
      const domain = getManagedDomain(tab);
      if (!domain) continue;

      const groupName = getGroupNameForDomain(domain, rules);
      const key = getBucketKey(tab.windowId, groupName);
      if (!domainMap[key]) {
        domainMap[key] = { windowId: tab.windowId, groupName, tabIds: [] };
      }
      if (!domainMap[key].tabIds.includes(tab.id)) {
        domainMap[key].tabIds.push(tab.id);
      }
    }

    for (const bucket of Object.values(domainMap)) {
      if (bucket.tabIds.length < 1) continue;

      try {
        const groupId = await chrome.tabs.group({ tabIds: bucket.tabIds });
        await chrome.tabGroups.update(groupId, {
          title: GROUP_PREFIX + bucket.groupName,
          collapsed: false
        });
      } catch {}
    }

    await sortAllGroups();
  } catch {}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getRules') {
    getRules().then(sendResponse);
    return true;
  }
  if (request.action === 'saveRules') {
    saveRules(request.rules).then(() => sendResponse({ success: true }));
    return true;
  }
  if (request.action === 'reconcileGroups') {
    reconcileGroups(request.rules || {}).then(() => sendResponse({ success: true }));
    return true;
  }
});

async function reconcileGroups(rules) {
  try {
    rules = normalizeRules(rules);

    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({});
    const tabsByGroup = new Map();

    for (const tab of tabs) {
      const domain = getManagedDomain(tab);
      if (!domain) continue;

      const groupName = getGroupNameForDomain(domain, rules);
      const bucketKey = getBucketKey(tab.windowId, groupName);
      if (!tabsByGroup.has(bucketKey)) {
        tabsByGroup.set(bucketKey, { windowId: tab.windowId, groupName, tabs: [] });
      }
      tabsByGroup.get(bucketKey).tabs.push(tab);
    }

    for (const bucket of tabsByGroup.values()) {
      const { windowId, groupName, tabs: groupTabs } = bucket;
      if (groupTabs.length < 1) continue;

      let targetGroup = groups.find(
        (group) => group.title === GROUP_PREFIX + groupName && group.windowId === windowId
      );

      if (!targetGroup) {
        const existingGroupedTab = groupTabs.find(
          (tab) => tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
        );

        if (existingGroupedTab) {
          try {
            await chrome.tabGroups.update(existingGroupedTab.groupId, {
              title: GROUP_PREFIX + groupName,
              collapsed: false
            });
            targetGroup = await chrome.tabGroups.get(existingGroupedTab.groupId);
          } catch {}
        }
      }

      if (targetGroup) {
        for (const tab of groupTabs) {
          if (tab.groupId === targetGroup.id) continue;

          try {
            await chrome.tabs.group({ tabIds: [tab.id], groupId: targetGroup.id });
          } catch {}
        }

        try {
          await chrome.tabGroups.update(targetGroup.id, {
            title: GROUP_PREFIX + groupName,
            collapsed: false
          });
        } catch {}
      } else {
        try {
          const groupId = await chrome.tabs.group({ tabIds: groupTabs.map(t => t.id) });
          await chrome.tabGroups.update(groupId, {
            title: GROUP_PREFIX + groupName,
            collapsed: false
          });
        } catch {}
      }
    }

    await sortAllGroups();
  } catch {}
}
