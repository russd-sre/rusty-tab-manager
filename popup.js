const SAVE_DEBOUNCE_MS = 400;
let saveTimer = null;

async function loadRules() {
  const rules = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getRules" }, resolve);
  });
  return rules || {};
}

function createRuleRow(groupName, domainsText, isNew) {
  const row = document.createElement("div");
  row.className = "rule-row";

  const groupInput = document.createElement("input");
  groupInput.type = "text";
  groupInput.className = "group";
  groupInput.placeholder = "Group name";
  if (groupName) groupInput.value = groupName;

  const domainsInput = document.createElement("input");
  domainsInput.type = "text";
  domainsInput.className = "domains";
  domainsInput.placeholder = "Domains (comma separated)";
  if (domainsText) domainsInput.value = domainsText;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "X";
  if (isNew) {
    removeBtn.dataset.new = "true";
  } else if (groupName) {
    removeBtn.dataset.group = groupName;
  }

  row.appendChild(groupInput);
  row.appendChild(domainsInput);
  row.appendChild(removeBtn);
  return row;
}

function renderRules(rules) {
  const container = document.getElementById("rules");
  container.innerHTML = "";

  for (const [groupName, domains] of Object.entries(rules)) {
    container.appendChild(createRuleRow(groupName, domains.join(", "), false));
  }
}

function collectRules() {
  const rows = document.querySelectorAll(".rule-row");
  const rules = {};
  rows.forEach((row) => {
    const group = row.querySelector(".group").value.trim();
    const domains = row
      .querySelector(".domains")
      .value.split(",")
      .map((d) => d.trim())
      .filter((d) => d);
    if (group && domains.length > 0) {
      rules[group] = domains;
    }
  });
  return rules;
}

async function saveAndReconcile(rules) {
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "saveRules", rules }, resolve);
    });
    chrome.runtime.sendMessage({ action: "reconcileGroups", rules });
  } catch (err) {
    console.warn("failed to save rules:", err);
  }
}

function debouncedSaveAndReconcile() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveAndReconcile(collectRules());
  }, SAVE_DEBOUNCE_MS);
}

document.getElementById("addRule").addEventListener("click", () => {
  const container = document.getElementById("rules");
  container.appendChild(createRuleRow(null, null, true));
});

document.getElementById("rules").addEventListener("click", async (e) => {
  if (e.target.tagName !== "BUTTON") return;

  if (e.target.dataset.new) {
    e.target.closest(".rule-row").remove();
    return;
  }

  const rules = collectRules();
  delete rules[e.target.dataset.group];
  await saveAndReconcile(rules);
  renderRules(rules);
});

document.getElementById("rescan").addEventListener("click", async () => {
  const btn = document.getElementById("rescan");
  btn.disabled = true;
  btn.textContent = "Scanning...";
  try {
    const rules = await loadRules();
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "reconcileGroups", rules }, resolve);
    });
  } catch (err) {
    console.warn("rescan failed:", err);
  }
  btn.textContent = "Re-scan Tabs";
  btn.disabled = false;
});

document.getElementById("expandAll").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "expandAllGroups" });
});

document.getElementById("collapseAll").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "collapseAllGroups" });
});

document.getElementById("groupAudio").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "groupAudioTabs" });
});

document.getElementById("ungroupAudio").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "ungroupAudioTabs" });
});

document.getElementById("closeGrouped").addEventListener("click", () => {
  if (!confirm("Close all grouped tabs? Pinned tabs will be kept.")) return;
  chrome.runtime.sendMessage({ action: "closeAllGroupedTabs" });
});

const groupingBtn = document.getElementById("toggleGrouping");

function applyUngroupedState(ungrouped) {
  groupingBtn.textContent = ungrouped ? "Regroup All" : "Ungroup All";
  groupingBtn.classList.toggle("ungrouped", ungrouped);
}

groupingBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "toggleGrouping" }, (response) => {
    applyUngroupedState(response?.ungrouped ?? false);
  });
});

chrome.runtime.sendMessage({ action: "getUngrouped" }, (response) => {
  applyUngroupedState(response?.ungrouped ?? false);
});

const pauseBtn = document.getElementById("togglePause");

function applyPausedState(paused) {
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  pauseBtn.classList.toggle("paused", paused);
}

pauseBtn.addEventListener("click", () => {
  const nowPaused = !pauseBtn.classList.contains("paused");
  chrome.runtime.sendMessage({ action: "setPaused", paused: nowPaused });
  applyPausedState(nowPaused);
});

chrome.runtime.sendMessage({ action: "getPaused" }, (response) => {
  applyPausedState(response?.paused ?? false);
});

document.getElementById("rules").addEventListener("input", debouncedSaveAndReconcile);

loadRules().then(renderRules);
