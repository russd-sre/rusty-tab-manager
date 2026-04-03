async function loadRules() {
  const rules = await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'getRules' }, resolve);
  });
  return rules || {};
}

function renderRules(rules) {
  const container = document.getElementById('rules');
  container.innerHTML = '';

  for (const [groupName, domains] of Object.entries(rules)) {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <input type="text" class="group" value="${groupName}" placeholder="Group name">
      <input type="text" class="domains" value="${domains.join(', ')}" placeholder="Domains (comma separated)">
      <button data-group="${groupName}">X</button>
    `;
    container.appendChild(row);
  }
}

function collectRules() {
  const rows = document.querySelectorAll('.rule-row');
  const rules = {};
  rows.forEach(row => {
    const group = row.querySelector('.group').value.trim();
    const domains = row.querySelector('.domains').value.split(',').map(d => d.trim()).filter(d => d);
    if (group && domains.length > 0) {
      rules[group] = domains;
    }
  });
  return rules;
}

document.getElementById('addRule').addEventListener('click', () => {
  const container = document.getElementById('rules');
  const row = document.createElement('div');
  row.className = 'rule-row';
  row.innerHTML = `
    <input type="text" class="group" placeholder="Group name">
    <input type="text" class="domains" placeholder="Domains (comma separated)">
    <button data-new="true">X</button>
  `;
  container.appendChild(row);
});

document.getElementById('rules').addEventListener('click', async (e) => {
  if (e.target.tagName === 'BUTTON') {
    const rules = collectRules();
    if (e.target.dataset.new) {
      e.target.closest('.rule-row').remove();
    } else {
      delete rules[e.target.dataset.group];
      await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'saveRules', rules }, resolve);
      });
      chrome.runtime.sendMessage({ action: 'reconcileGroups', rules });
      renderRules(rules);
    }
  }
});

document.getElementById('rules').addEventListener('input', async () => {
  const rules = collectRules();
  await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'saveRules', rules }, resolve);
  });
  chrome.runtime.sendMessage({ action: 'reconcileGroups', rules });
});

loadRules().then(renderRules);