const LABELS_KEY = 'labels';
const OSINT_KEY = 'osint_sources';

function defaultOsintSources() {
  return [
    { name: 'Arkham', pattern: 'https://intel.arkm.com/explorer/address/{}' },
    { name: 'DeBank', pattern: 'https://debank.com/profile/{}' },
  ];
}

init();

async function init() {
  clearMessages();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const detectedAddr = extractAddressFromUrl(url);

  const detectedEl = document.getElementById('detected');
  const detectedRow = document.getElementById('detectedRow');
  const manualToggle = document.getElementById('manualToggle');
  const addrInput = document.getElementById('addrInput');
  const labelInput = document.getElementById('label');
  const saveBtn = document.getElementById('save');
  const delBtn = document.getElementById('delete');
  const osintButtonsEl = document.getElementById('osintButtons');
  const osintListEl = document.getElementById('osintList');
  const osintNameEl = document.getElementById('osintName');
  const osintPatternEl = document.getElementById('osintPattern');
  const osintAddBtn = document.getElementById('osintAddBtn');

  let osintSources = await getOsintSources();
  if (!osintSources || !osintSources.length) {
    osintSources = defaultOsintSources();
    await chrome.storage.local.set({ [OSINT_KEY]: osintSources });
  }
  renderOsintButtons(osintButtonsEl, osintSources, () => (document.getElementById('addrInput')?.value || ''));
  renderOsintManager(osintListEl, osintSources, async (updated) => {
    await chrome.storage.local.set({ [OSINT_KEY]: updated });
    renderOsintButtons(osintButtonsEl, updated, () => (document.getElementById('addrInput')?.value || ''));
  });

  osintAddBtn.addEventListener('click', async () => {
    clearMessages();
    const name = (osintNameEl.value || '').trim();
    let pattern = (osintPatternEl.value || '').trim();
    if (!name) return setError('Site name is required');
    if (!pattern) return setError('URL pattern is required');
    const cur = await getOsintSources();
    cur.push({ name, pattern });
    await chrome.storage.local.set({ [OSINT_KEY]: cur });
    osintNameEl.value = '';
    osintPatternEl.value = '';
    renderOsintButtons(osintButtonsEl, cur, () => (document.getElementById('addrInput')?.value || ''));
    renderOsintManager(osintListEl, cur, async (updated) => {
      await chrome.storage.local.set({ [OSINT_KEY]: updated });
      renderOsintButtons(osintButtonsEl, updated, () => (document.getElementById('addrInput')?.value || ''));
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[OSINT_KEY]) {
      const updated = changes[OSINT_KEY].newValue || [];
      renderOsintButtons(osintButtonsEl, updated, () => (document.getElementById('addrInput')?.value || ''));
      renderOsintManager(osintListEl, updated, async (u) => {
        await chrome.storage.local.set({ [OSINT_KEY]: u });
        renderOsintButtons(osintButtonsEl, u, () => (document.getElementById('addrInput')?.value || ''));
      });
    }
  });

  if (detectedAddr) {
    detectedEl.textContent = detectedAddr;
    detectedRow.style.display = '';
    addrInput.value = detectedAddr;
    manualToggle.checked = false;
    addrInput.disabled = true;
  } else {
    detectedRow.style.display = 'none';
    manualToggle.checked = true;
    addrInput.disabled = false;
  }

  // Preload label for the current value
  await preloadLabelFor(addrInput.value);

  manualToggle.addEventListener('change', () => {
    addrInput.disabled = !manualToggle.checked;
    if (!manualToggle.checked && detectedAddr) {
      addrInput.value = detectedAddr;
      preloadLabelFor(detectedAddr);
    }
  });

  addrInput.addEventListener('input', async () => {
    clearMessages();
    await preloadLabelFor(addrInput.value);
  });

  saveBtn.addEventListener('click', async () => {
    clearMessages();
    const addrRaw = addrInput.value.trim();
    if (!isValidAddr(addrRaw)) return setError('Enter a valid address (0x…)');
    const norm = normalize(addrRaw);
    const label = labelInput.value.trim();
    if (!label) return setError('Label is required');
    const { [LABELS_KEY]: labels = {} } = await chrome.storage.local.get(LABELS_KEY);
    labels[norm] = { label, updatedAt: Date.now() };
    await chrome.storage.local.set({ [LABELS_KEY]: labels });
    setMsg('Saved ✔');
    await notifyPage();
  });

  delBtn.addEventListener('click', async () => {
    clearMessages();
    const addrRaw = addrInput.value.trim();
    if (!isValidAddr(addrRaw)) return setError('Enter a valid address (0x…)');
    const norm = normalize(addrRaw);
    const { [LABELS_KEY]: labels = {} } = await chrome.storage.local.get(LABELS_KEY);
    if (labels[norm]) {
      delete labels[norm];
      await chrome.storage.local.set({ [LABELS_KEY]: labels });
      labelInput.value = '';
      setMsg('Deleted');
      await notifyPage();
    } else {
      setError('No label to delete');
    }
  });

  /* ---------- import / export ---------- */
  const formatSel = document.getElementById('format');
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const fileInput = document.getElementById('fileInput');

  exportBtn.addEventListener('click', async () => {
    clearMessages();
    const fmt = formatSel.value;
    const { [LABELS_KEY]: labels = {} } = await chrome.storage.local.get(LABELS_KEY);
    try {
      if (fmt === 'csv') {
        const csv = labelsToCsv(labels);
        triggerDownload(csv, `ronin-labels-${ts()}.csv`, 'text/csv');
      } else {
        const json = labelsToJson(labels);
        triggerDownload(json, `ronin-labels-${ts()}.json`, 'application/json');
      }
      setMsg('Exported');
    } catch (e) {
      setError('Export failed');
    }
  });

  importBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    clearMessages();
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const imported = ext === 'csv' ? parseCsv(text) : parseJson(text);
      const count = await mergeImported(imported);
      setMsg(`Imported ${count} label(s)`);
      await notifyPage();
    } catch {
      setError('Import failed: invalid file');
    } finally {
      e.target.value = '';
    }
  });
}

async function preloadLabelFor(addrRaw) {
  const norm = normalize(addrRaw);
  const data = await chrome.storage.local.get(LABELS_KEY);
  const existing = (data && data[LABELS_KEY]) || {};
  const labelInput = document.getElementById('label');
  labelInput.value = existing[norm]?.label || '';
}

function extractAddressFromUrl(url) {
  if (!url) return '';
  // Common path forms across explorers
  let m = url.match(/\/(address|token|account)\/(0x[0-9a-fA-F]{40})/);
  if (m) return m[2];
  // Query params used by many scanners (a, address, addr)
  m = url.match(/[?&#](a|address|addr)=?(0x[0-9a-fA-F]{40})/);
  if (m) return m[2];
  return '';
}

function isValidAddr(a) {
  if (!a) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

function normalize(a) {
  if (!a) return '';
  let s = String(a).trim();
  if (s.toLowerCase().startsWith('ronin:')) s = '0x' + s.slice(6);
  const m = s.match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0].toLowerCase() : '';
}

function setMsg(t) { document.getElementById('msg').textContent = t; }
function setError(t) { document.getElementById('error').textContent = t; }
function clearMessages() { setMsg(''); setError(''); }

async function notifyPage() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) return;
  try {
    await chrome.tabs.sendMessage(active.id, { type: 'labelsUpdated' });
  } catch (_) {
    // Content script might not be injected on this site yet; inject and retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: active.id },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(active.id, { type: 'labelsUpdated' });
    } catch (e) {
      // Silent fail – user may have restricted site access.
    }
  }
}

/* ---------- helper functions ---------- */

function labelsToCsv(labels) {
  const rows = ['address,label'];
  for (const [addr, obj] of Object.entries(labels)) {
    const label = (obj && obj.label) ? obj.label : '';
    const safe = label.includes(',') || label.includes('"')
      ? '"' + label.replace(/"/g, '""') + '"'
      : label;
    rows.push(`${addr},${safe}`);
  }
  return rows.join('\n');
}

function labelsToJson(labels) {
  const arr = Object.entries(labels).map(([address, v]) => ({ address, label: v.label || '' }));
  return JSON.stringify(arr, null, 2);
}

function parseJson(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data.map(x => ({ address: x.address, label: x.label }));
  if (data && typeof data === 'object')
    return Object.entries(data).map(([address, label]) => ({ address, label }));
  return [];
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map(s => s.trim().toLowerCase());
  const ai = header.indexOf('address');
  const li = header.indexOf('label');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const address = (cols[ai] || '').trim();
    const label = (cols[li] || '').trim();
    if (address && label) rows.push({ address, label });
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"') {
        inQ = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

async function mergeImported(items) {
  const now = Date.now();
  const { [LABELS_KEY]: existing = {} } = await chrome.storage.local.get(LABELS_KEY);
  let count = 0;
  for (const it of items) {
    const norm = normalize(it.address);
    const label = (it.label || '').trim();
    if (!norm || !label) continue;
    existing[norm] = { label, updatedAt: now };
    count++;
  }
  await chrome.storage.local.set({ [LABELS_KEY]: existing });
  return count;
}

async function getOsintSources() {
  const data = await chrome.storage.local.get(OSINT_KEY);
  return data[OSINT_KEY] || [];
}

function renderOsintButtons(container, sources, getAddr) {
  container.innerHTML = '';
  const srcs = Array.isArray(sources) && sources.length ? sources : defaultOsintSources();
  for (const s of srcs) {
    const btn = document.createElement('button');
    btn.textContent = s.name;
    btn.addEventListener('click', () => openOsintPattern(s.pattern, getAddr()));
    container.appendChild(btn);
  }
}

function renderOsintManager(container, sources, onChange) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  list.style.gap = '6px';
  (sources || []).forEach((s, idx) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    const name = document.createElement('span');
    name.textContent = s.name;
    const pat = document.createElement('code');
    pat.textContent = s.pattern;
    pat.style.whiteSpace = 'pre-wrap';
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      const updated = sources.slice();
      updated.splice(idx, 1);
      await onChange(updated);
    });
    row.appendChild(name);
    row.appendChild(pat);
    row.appendChild(del);
    list.appendChild(row);
  });
  container.appendChild(list);
}

function openOsintPattern(pattern, addrRaw) {
  clearMessages();
  const a = (addrRaw || '').trim();
  if (!isValidAddr(a)) return setError('Enter a valid address (0x…)');
  const norm = normalize(a);
  const pat = toPattern(pattern || '');
  if (!pat) return setError('Invalid OSINT pattern');
  const url = pat.replace('{}', norm);
  chrome.tabs.create({ url });
}

/* ---------- external OSINT helpers ---------- */
function openOsint(site) {
  const addrRaw = (document.getElementById('addrInput')?.value || '').trim();
  let pattern = '';
  if (site === 'arkham') {
    pattern = 'https://intel.arkm.com/explorer/address/{}';
  } else if (site === 'debank') {
    pattern = 'https://debank.com/profile/{}';
  }
  openOsintPattern(pattern, addrRaw);
}

/* ---------- pattern helper ---------- */
function toPattern(sample) {
  let p = (sample || '').trim();
  if (!p) return '';
  if (!/^https?:\/\//i.test(p)) p = 'https://' + p;
  if (p.includes('{}')) return p; // already a pattern

  // Replace explicit address occurrences first
  const addrRe = /(0x[0-9a-fA-F]{40}|ronin:[0-9a-fA-F]{40})/;
  if (addrRe.test(p)) return p.replace(addrRe, '{}');

  // Replace value of common query params
  const qParamRe = /([?&](?:a|addr|address)=)[^&#]*/i;
  if (qParamRe.test(p)) return p.replace(qParamRe, '$1{}');

  // Replace path segment after /address|/token|/account
  const pathRe = /(\/)(address|token|account)(\/)[^/?#]+/i;
  if (pathRe.test(p)) return p.replace(pathRe, '$1$2$3{}');

  // Fallback: append placeholder at end
  return p.replace(/\/*$/, '/') + '{}';
}

function triggerDownload(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}