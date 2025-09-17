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
    if (!isValidAddr(addrRaw)) return setError('Enter a valid address (0x… or ronin:…)');
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
    if (!isValidAddr(addrRaw)) return setError('Enter a valid address (0x… or ronin:…)');
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
  // Match /address|token|account/<addr> where <addr> is 0x... or ronin:...
  const m = url.match(/\/(address|token|account)\/(ronin:[0-9a-fA-F]{40}|0x[0-9a-fA-F]{40})/);
  if (m) return m[2];
  // Fallback: query params like ?address=<addr>
  const qm = url.match(/[?&#](address|addr)=?(ronin:[0-9a-fA-F]{40}|0x[0-9a-fA-F]{40})/);
  if (qm) return qm[2];
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
  if (active?.id) {
    try { await chrome.tabs.sendMessage(active.id, { type: 'labelsUpdated' }); } catch (_) {}
  }
}