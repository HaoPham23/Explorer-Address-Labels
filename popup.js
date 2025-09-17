const LABELS_KEY = 'labels';

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
  let m = url.match(/\/(address|token|account)\/(ronin:[0-9a-fA-F]{40}|0x[0-9a-fA-F]{40})/);
  if (m) return m[2];
  // Query params used by many scanners (a, address, addr)
  m = url.match(/[?&#](a|address|addr)=?(ronin:[0-9a-fA-F]{40}|0x[0-9a-fA-F]{40})/);
  if (m) return m[2];
  return '';
}

function isValidAddr(a) {
  if (!a) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(a) || /^ronin:[0-9a-fA-F]{40}$/i.test(a);
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