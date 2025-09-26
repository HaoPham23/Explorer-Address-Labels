const LABELS_KEY = 'labels';

init();

async function init() {
  const params = new URLSearchParams(location.search);
  const startQ = (params.get('q') || '').trim();
  const qEl = document.getElementById('q');
  const resultsEl = document.getElementById('results');

  let all = (await chrome.storage.local.get(LABELS_KEY))[LABELS_KEY] || {};

  const render = () => {
    const q = (qEl.value || '').trim().toLowerCase();
    resultsEl.innerHTML = '';
    if (!q) return;
    const items = [];
    for (const [address, v] of Object.entries(all)) {
      const lab = (v && v.label) ? String(v.label) : '';
      const note = (v && v.note) ? String(v.note) : '';
      const labL = lab.toLowerCase();
      const noteL = note.toLowerCase();
      if (!labL && !noteL) continue;
      if (labL.includes(q) || noteL.includes(q)) items.push({ address, label: lab || '(no label)', updatedAt: v.updatedAt || 0 });
    }
    items.sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));
    items.forEach(it => {
      const row = document.createElement('div');
      row.className = 'item';
      const meta = document.createElement('div'); meta.className = 'meta';
      const l1 = document.createElement('div'); l1.textContent = it.label;
      const l2 = document.createElement('div'); l2.className='addr'; l2.textContent = it.address; l2.title = 'Click to copy';
      l2.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(it.address); } catch {}
      });
      meta.appendChild(l1); meta.appendChild(l2);
      const actions = document.createElement('div'); actions.className='actions';
      const openBtn = document.createElement('button'); openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => openOnCurrentExplorer(it.address));
      const copyBtn = document.createElement('button'); copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(it.address); copyBtn.textContent='Copied'; setTimeout(()=>copyBtn.textContent='Copy',800);} catch {}
      });
      actions.appendChild(openBtn); actions.appendChild(copyBtn);
      row.appendChild(meta); row.appendChild(actions);
      resultsEl.appendChild(row);
    });
  };

  qEl.addEventListener('input', render);
  if (startQ) { qEl.value = startQ; }
  render();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LABELS_KEY]) {
      all = changes[LABELS_KEY].newValue || {};
      render();
    }
  });
}

function shorten(addr) {
  const a = (addr || '').toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return addr;
  return a.slice(0, 6) + '…' + a.slice(-4);
}

async function openOnCurrentExplorer(addr) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  let base = detectExplorerBase(url);
  if (!base) base = 'https://etherscan.io';
  const target = `${base.replace(/\/$/,'')}/address/${addr}`;
  if (tab?.id) await chrome.tabs.update(tab.id, { url: target });
  window.close();
}

function detectExplorerBase(u) {
  try {
    const { hostname, protocol } = new URL(u);
    if (!hostname) return '';
    if (hostname.endsWith('etherscan.io')) return `${protocol}//${hostname}`;
    if (hostname.endsWith('bscscan.com')) return `${protocol}//${hostname}`;
    if (hostname.endsWith('arbiscan.io')) return `${protocol}//${hostname}`;
    if (hostname.endsWith('polygonscan.com')) return `${protocol}//${hostname}`;
    if (hostname.endsWith('basescan.org')) return `${protocol}//${hostname}`;
    if (hostname === 'app.roninchain.com') return `${protocol}//${hostname}`;
    return '';
  } catch { return ''; }
}