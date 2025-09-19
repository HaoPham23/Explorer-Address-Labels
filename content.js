const LABELS_KEY = 'labels';
const OSINT_KEY = 'osint_sources';
let osintSources = [];
let labels = {};
// Debounce timer for expensive annotate work
let scheduleTimer = null;
let explabelMenu = null; let explabelMenuAddr = null; let explabelOutside = null; let explabelKeyHandler = null;

// Re-injection guard: if the script is injected again (e.g. via chrome.scripting)
// avoid double observers / listeners.
if (window.__explabel_injected) {
  // Already active – just refresh data & annotations quickly.
  try {
    loadLabels().then(annotatePage);
  } catch (_) {
    /* no-op */
  }
} else {
  window.__explabel_injected = true;
  init();
}

async function init() {
  injectStyle();
  await loadLabels();
  await loadOsintSources();
  annotatePage();
  const observer = new MutationObserver(() => scheduleAnnotate());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LABELS_KEY]) {
      labels = changes[LABELS_KEY].newValue || {};
      scheduleAnnotate();
    }
    if (area === 'local' && changes[OSINT_KEY]) {
      osintSources = changes[OSINT_KEY].newValue || [];
    }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'labelsUpdated') {
      loadLabels().then(scheduleAnnotate);
    }
  });
}

function injectStyle() {
  if (document.getElementById('explabel-style')) return; // already injected
  const css = `
    .explabel-edit {
      display: inline-block;
      margin-left: 4px;
      padding: 0 4px;
      border-radius: 4px;
      background: #f0f0f0;
      color: #666;
      font-size: 11px;
      cursor: pointer;
      user-select: none;
    }
    .explabel-edit:hover {
      background: #e0e0e0;
      color: #333;
    }
    .explabel-wrap-full, .explabel-wrap-short {
      display: inline-flex;
      align-items: center;
    }
    .explabel-label {
      color: #1f6feb;
      font-weight: 600;
    }
    .explabel-addr-text {
      font-family: monospace;
    }
    /* inline menu */
    .explabel-menu {
      position: fixed;
      z-index: 2147483647;
      background:#fff;
      border:1px solid #ddd;
      border-radius:6px;
      box-shadow:0 4px 16px rgba(0,0,0,.12);
      padding:4px;
      min-width:160px;
      font-size:12px;
    }
    .explabel-menu button{
      display:block;
      width:100%;
      background:none;
      border:none;
      text-align:left;
      padding:6px 8px;
      cursor:pointer;
      border-radius:4px;
    }
    .explabel-menu button:hover{
      background:#f2f2f2;
    }
  `;
  const style = document.createElement('style');
  style.id = 'explabel-style';
  style.textContent = css;
  document.head.appendChild(style);
}

async function loadLabels() {
  const res = await chrome.storage.local.get(LABELS_KEY);
  labels = res[LABELS_KEY] || {};
}

// Load OSINT sources list from storage
async function loadOsintSources() {
  const res = await chrome.storage.local.get(OSINT_KEY);
  osintSources = res[OSINT_KEY] || [];
}

// Debounced annotate helper
function scheduleAnnotate() {
  if (scheduleTimer) return;
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    annotatePage();
  }, 250);
}

function annotatePage() {
  // Fast path: if we have no labels stored yet, only ensure edit buttons on anchors.
  const hasLabels = Object.keys(labels).length > 0;
  updateExistingShortWrappers();
  updateExistingFullWrappers();
  replaceAnchorTexts();
  if (hasLabels) replaceTextNodes();
}

function replaceAnchorTexts() {
  const anchors = document.querySelectorAll('a[href*="/address/"]');
  anchors.forEach(a => {
    const addr = extractAddressFromUrl(a.href);
    if (!addr) return;
    const key = normalize(addr);
    const label = labels[key]?.label;
    
    if (label) {
      if (!a.dataset.explabelOrig) a.dataset.explabelOrig = a.textContent;
      a.dataset.addr = key;
      
      // Clear existing content
      a.textContent = '';
      
      // Create and append label span
      const span = document.createElement('span');
      span.className = 'explabel-label';
      span.textContent = label;
      span.title = addr;
      a.appendChild(span);
    } else if (a.dataset.explabelOrig) {
      // label removed; restore original
      a.textContent = a.dataset.explabelOrig;
      delete a.dataset.explabelOrig;
      delete a.dataset.addr;
      a.removeAttribute('title');
    }
    // Always ensure an edit button exists after the anchor
    ensureEditAfter(a, key);
  });
}

function ensureEditAfter(element, addr) {
  const next = element.nextElementSibling;
  if (next && next.classList.contains('explabel-edit') && next.dataset.addr === addr) {
    return next; // Already exists
  }
  const btn = createEditButton(addr);
  element.insertAdjacentElement('afterend', btn);
  return btn;
}

function replaceTextNodes() {
  const MAX_NODES = 400;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.parentElement) return NodeFilter.FILTER_REJECT;
      // Skip inside script/style and elements we already labeled
      const tag = n.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (n.parentElement.closest('a')) return NodeFilter.FILTER_REJECT; // anchors handled separately
      if (n.parentElement.closest('.explabel-wrap-short')) return NodeFilter.FILTER_REJECT;
      if (n.parentElement.closest('.explabel-wrap-full')) return NodeFilter.FILTER_REJECT;
      return /(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{4,20}(?:…|\.{3})[0-9a-fA-F]{4,20})/.test(n.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  const toProcess = [];
  let node; let counter = 0; let more = false;
  while ((node = walker.nextNode())) {
    toProcess.push(node);
    if (++counter >= MAX_NODES) { more = true; break; }
  }
  toProcess.forEach(n => replaceMatchesInTextNode(n));
  if (more) scheduleAnnotate(); // continue processing remaining nodes later
}

// ---------- replacement helpers ----------

function replaceMatchesInTextNode(textNode) {
  if (replaceFullAddresses(textNode)) return;
  replaceShortAddresses(textNode);
}

function replaceFullAddresses(textNode) {
  if (!textNode || !textNode.isConnected || !textNode.parentNode) return false;
  
  const text = textNode.nodeValue;
  // match standalone 40-hex addresses only; ignore if another hex char follows
  const re = /(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;
  let m, last = 0, changed = false;
  const frag = document.createDocumentFragment();
  while ((m = re.exec(text)) !== null) {
    const addr = m[0];
    const key = normalize(addr);
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    
    // Create wrapper for the address
    const wrap = document.createElement('span');
    wrap.className = 'explabel-wrap-full';
    wrap.dataset.addr = key;
    wrap.dataset.original = addr;
    
    // Add either label or original address text
    const label = labels[key]?.label;
    if (label) {
      const span = document.createElement('span');
      span.className = 'explabel-label';
      span.textContent = label;
      span.title = addr;
      wrap.appendChild(span);
    } else {
      const span = document.createElement('span');
      span.className = 'explabel-addr-text';
      span.textContent = addr;
      wrap.appendChild(span);
    }
    
    // Add edit button
    wrap.appendChild(createEditButton(key));
    
    frag.appendChild(wrap);
    last = re.lastIndex;
    changed = true;
  }
  if (!changed) return false;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  
  if (!textNode.isConnected || !textNode.parentNode) return false;
  try {
    textNode.parentNode.replaceChild(frag, textNode);
  } catch (_) {
    return false;
  }
  return true;
}

function replaceShortAddresses(textNode) {
  if (!textNode || !textNode.isConnected || !textNode.parentNode) return false;
  
  const text = textNode.nodeValue;
  const reShort = /(0x[0-9a-fA-F]{4,20})(?:…|\.{3})([0-9a-fA-F]{4,20})/g;
  let m, last = 0, changed = false;
  const frag = document.createDocumentFragment();
  while ((m = reShort.exec(text)) !== null) {
    const pref = m[1].toLowerCase();
    const suff = m[2].toLowerCase();
    const full = findMatchForShort(pref, suff);
    if (!full) continue; // no unique match
    const label = labels[full]?.label;
    if (!label) continue;
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));

    const wrap = document.createElement('span');
    wrap.className = 'explabel-wrap-short';
    wrap.dataset.addr = full;
    wrap.dataset.original = m[0];

    // keep the original shortened address text
    wrap.appendChild(document.createTextNode(m[0]));

    // append the label in parentheses
    const span = document.createElement('span');
    span.className = 'explabel-label-short';
    span.textContent = ` (${label})`;
    span.title = full;
    wrap.appendChild(span);
    
    // Add edit button
    wrap.appendChild(createEditButton(full));

    frag.appendChild(wrap);
    last = reShort.lastIndex;
    changed = true;
  }
  if (!changed) return false;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  
  if (!textNode.isConnected || !textNode.parentNode) return false;
  try {
    textNode.parentNode.replaceChild(frag, textNode);
  } catch (_) {
    return false;
  }
  return true;
}

function findMatchForShort(prefix, suffix) {
  let found = '';
  for (const key of Object.keys(labels)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      if (!found) {
        found = key;
      } else {
        return ''; // ambiguous
      }
    }
  }
  return found;
}

function updateExistingLabelSpans() {
  document.querySelectorAll('span.explabel-label').forEach(span => {
    const key = span.dataset.addr;
    const label = labels[key]?.label;
    if (label) {
      if (span.textContent !== label) span.textContent = label;
    } else {
      // label removed; restore original address text
      const orig = span.dataset.original || '';
      const text = document.createTextNode(orig || span.textContent);
      span.replaceWith(text);
    }
  });
}

function updateExistingShortWrappers() {
  document.querySelectorAll('span.explabel-wrap-short').forEach(wrap => {
    const key = wrap.dataset.addr;
    const label = labels[key]?.label;
    const labelSpan = wrap.querySelector('.explabel-label-short');
    if (label) {
      const txt = ` (${label})`;
      if (!labelSpan) {
        const s = document.createElement('span');
        s.className = 'explabel-label-short';
        s.textContent = txt;
        s.title = key;
        wrap.appendChild(s);
      } else if (labelSpan.textContent !== txt) {
        labelSpan.textContent = txt;
        labelSpan.title = key;
      }
      
      // Ensure edit button exists
      let editBtn = wrap.querySelector('.explabel-edit');
      if (!editBtn) {
        editBtn = createEditButton(key);
        wrap.appendChild(editBtn);
      }
    } else {
      // remove wrapper entirely and restore original shortened text
      const orig = wrap.dataset.original || wrap.textContent;
      const n = document.createTextNode(orig);
      if (wrap && wrap.isConnected) wrap.replaceWith(n);
    }
  });
}

function updateExistingFullWrappers() {
  document.querySelectorAll('span.explabel-wrap-full').forEach(wrap => {
    const key = wrap.dataset.addr;
    const label = labels[key]?.label;
    const orig = wrap.dataset.original;
    
    // Update inner content based on label presence
    let contentSpan = wrap.querySelector('.explabel-label, .explabel-addr-text');
    if (!contentSpan) {
      contentSpan = document.createElement('span');
      wrap.insertBefore(contentSpan, wrap.firstChild);
    }
    
    if (label) {
      contentSpan.className = 'explabel-label';
      contentSpan.textContent = label;
      contentSpan.title = orig;
    } else {
      contentSpan.className = 'explabel-addr-text';
      contentSpan.textContent = orig;
      contentSpan.removeAttribute('title');
    }
    
    // Ensure edit button exists
    let editBtn = wrap.querySelector('.explabel-edit');
    if (!editBtn) {
      editBtn = createEditButton(key);
      wrap.appendChild(editBtn);
    } else if (editBtn.dataset.addr !== key) {
      editBtn.dataset.addr = key;
    }
  });
}

function createEditButton(addr) {
  const b = document.createElement('span');
  b.className = 'explabel-edit';
  b.dataset.addr = addr;
  b.textContent = '✎';
  b.title = 'Edit / OSINT';
  b.addEventListener('click', onEditClick);
  return b;
}

async function onEditClick(e) {
  e.stopPropagation();
  e.preventDefault();
  const btn = e.currentTarget;
  const addr = btn?.dataset?.addr;
  if (!addr) return;
  if (explabelMenu && explabelMenuAddr === addr) { closeMenu(); return; }
  openMenuAt(btn, addr);
}

async function editLabel(addr) {
  const current = labels[addr]?.label || '';
  const next = prompt(`Label for ${addr}`, current);
  if (next === null) return; // cancelled
  const store = (await chrome.storage.local.get(LABELS_KEY))[LABELS_KEY] || {};
  if (next.trim()) {
    store[addr] = { label: next.trim(), updatedAt: Date.now() };
  } else {
    delete store[addr];
  }
  await chrome.storage.local.set({ [LABELS_KEY]: store });
  await loadLabels();
  annotatePage();
}

function openMenuAt(anchorEl, addr) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'explabel-menu';
  const mk = (text) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; return b; };
  const bEdit = mk('Edit label…');
  bEdit.addEventListener('click', async (e) => { e.stopPropagation(); await editLabel(addr); closeMenu(); });
  menu.appendChild(bEdit);

  const list = (osintSources && osintSources.length) ? osintSources : defaultOsintSources();
  for (const s of list) {
    const btn = mk(`Open in ${s.name}`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(buildOsintUrl(s.pattern, addr), '_blank', 'noopener');
      closeMenu();
    });
    menu.appendChild(btn);
  }
  const r = anchorEl.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = r.left + 'px';
  document.body.appendChild(menu);
  explabelMenu = menu; explabelMenuAddr = addr;
  explabelOutside = (ev) => { if (!menu.contains(ev.target)) closeMenu(); };
  explabelKeyHandler = (ev) => { if (ev.key === 'Escape') closeMenu(); };
  document.addEventListener('mousedown', explabelOutside, true);
  document.addEventListener('keydown', explabelKeyHandler, true);
}

function closeMenu() {
  try {
    // remove only if still in DOM to avoid NotFoundError
    if (explabelMenu && explabelMenu.isConnected) {
      explabelMenu.remove();
    }
  } catch (_) {
    /* ignore race */
  }
  if (explabelOutside) document.removeEventListener('mousedown', explabelOutside, true);
  if (explabelKeyHandler) document.removeEventListener('keydown', explabelKeyHandler, true);
  explabelMenu = null;
  explabelMenuAddr = null;
  explabelOutside = null;
  explabelKeyHandler = null;
}
