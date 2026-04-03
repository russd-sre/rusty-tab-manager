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

async function getRules() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['domainRules'], (result) => {
      resolve(result.domainRules || DEFAULT_RULES);
    });
  });
}

async function saveRules(rules) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ domainRules: rules }, resolve);
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

function getGroupDomains(domain, rules) {
  const groupName = findGroupForDomain(domain, rules);
  if (groupName) {
    return { domains: rules[groupName], groupName };
  }
  const truncated = truncateDomain(domain);
  return { domains: [domain], groupName: truncated };
}

async function getOrCreateGroup(domain, rules) {
  const { domains, groupName } = getGroupDomains(domain, rules);
  const groups = await chrome.tabGroups.query({});
  const existing = groups.find(g => g.title === GROUP_PREFIX + groupName);
  if (existing) return existing;

  const tabs = await chrome.tabs.query({});
  const domainToGroup = getAllDomainsForGroup(rules);
  const domainTabs = tabs.filter(t => {
    if (t.pinned) return false;
    const tabDomain = getSecondLevelDomain(t.url);
    if (!tabDomain) return false;
    if (domains.includes(tabDomain)) return true;
    if (domainToGroup.has(tabDomain) && domainToGroup.get(tabDomain) === groupName) return true;
    return false;
  });

  if (domainTabs.length >= 2) {
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
  const group = await getOrCreateGroup(domain, rules);
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
    const { groupName } = getGroupDomains(domain, rules);
    const existingGroup = groups.find(g => g.title === GROUP_PREFIX + groupName);

    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || !existingGroup) {
      const group = await getOrCreateGroup(domain, rules);
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
    const group = await getOrCreateGroup(domain, rules);
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
    const domainToGroup = getAllDomainsForGroup(rules);

    for (const tab of tabs) {
      if (!tab || !tab.url || tab.url.startsWith("chrome://")) continue;
      if (tab.pinned) continue;
      const domain = getSecondLevelDomain(tab.url);
      if (!domain) continue;

      const mappedGroup = domainToGroup.get(domain);
      const key = mappedGroup || truncateDomain(domain);
      if (!domainMap[key]) domainMap[key] = [];
      if (!domainMap[key].includes(tab.id)) {
        domainMap[key].push(tab.id);
      }
    }

    for (const domain of Object.keys(domainMap)) {
      try {
        const groupId = await chrome.tabs.group({ tabIds: domainMap[domain] });
        await chrome.tabGroups.update(groupId, {
          title: GROUP_PREFIX + domain,
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
});