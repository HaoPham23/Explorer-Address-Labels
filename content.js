const LABELS_KEY = 'labels';
const OSINT_KEY = 'osint_sources';
let osintSources = [];
let labels = {};
// Debounce timer for expensive annotate work
let scheduleTimer = null;
let pendingRoots = new Set();
let initialAnnotated = false;
let explabelMenu = null; let explabelMenuAddr = null; let explabelOutside = null; let explabelKeyHandler = null;
let explabelTip = null; let explabelShiftDown = false;

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
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.addedNodes && rec.addedNodes.length) {
        rec.addedNodes.forEach((n) => {
          if (n && n.nodeType === Node.ELEMENT_NODE) {
            scheduleAnnotate(n);
          }
        });
      }
    }
  });
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
      loadLabels().then(() => scheduleAnnotate());
    }
  });
  document.addEventListener('mousemove', onTipHover, true);
  document.addEventListener('keydown', (e)=>{ if (e.key==='Shift') explabelShiftDown = true; }, true);
  document.addEventListener('keyup', (e)=>{ if (e.key==='Shift') { explabelShiftDown=false; hideTip(); } }, true);
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
    .explabel-label-short { margin-left: 4px; }
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
    .explabel-note { display:inline-block; margin-left:4px; font-size:12px; cursor:help; }
    .explabel-tooltip { position: fixed; z-index:2147483647; background:#111; color:#fff; padding:4px 6px; border-radius:4px; font-size:12px; max-width:280px; box-shadow:0 2px 8px rgba(0,0,0,0.25); }
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
function scheduleAnnotate(root) {
  if (root) pendingRoots.add(root);
  if (scheduleTimer) return;
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    if (pendingRoots.size > 0) {
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      annotateIncremental(roots);
    } else {
      annotatePage();
    }
  }, 250);
}

function annotatePage() {
  // Fast path: if we have no labels stored yet, only ensure edit buttons on anchors.
  const hasLabels = Object.keys(labels).length > 0;
  updateExistingShortWrappers();
  updateExistingFullWrappers();
  replaceAnchorTexts();
  if (hasLabels) replaceTextNodes();
  initialAnnotated = true;
}

function annotateIncremental(roots) {
  // Process only within provided roots to avoid full-page rescans.
  const hasLabels = Object.keys(labels).length > 0;
  for (const root of roots) {
    if (!root || !root.isConnected) continue;
    // Anchors in this subtree (include the root itself if it is an anchor)
    if (root.matches && root.matches('a[href*="/address/"]')) processAnchor(root);
    root.querySelectorAll && root.querySelectorAll('a[href*="/address/"]').forEach(processAnchor);
    // Text nodes in this subtree (only if we have labels)
    if (hasLabels) replaceTextNodesInRoot(root);
  }
}

function replaceAnchorTexts() {
  const anchors = document.querySelectorAll('a[href*="/address/"]');
  anchors.forEach(processAnchor);
}

function processAnchor(a){
  if (!a || !a.href) return;
  const addr = extractAddressFromUrl(a.href);
  if (!addr) return;
  const key = normalize(addr);
  const label = labels[key]?.label;
  // Prefer an edit button INSIDE the anchor; remove legacy sibling if present
  const legacy = a.nextElementSibling && a.nextElementSibling.classList && a.nextElementSibling.classList.contains('explabel-edit') ? a.nextElementSibling : null;
  if (legacy) { try { legacy.remove(); } catch (_) {} }
  const innerEdit = a.querySelector('.explabel-edit');
  const hasEdit = innerEdit && innerEdit.dataset.addr === key;
  if (!label && hasEdit && !a.dataset.explabelOrig) {
    // No label and already has edit button; nothing else to do
    return;
  }
  if (label) {
    if (!a.dataset.explabelOrig) a.dataset.explabelOrig = a.textContent;
    a.dataset.addr = key;
    // Clear and render label span
    a.textContent = '';
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
    const next=a.nextElementSibling; if (next && next.classList.contains('explabel-note')) next.remove();
  }
  const editBtn = ensureEditAfter(a, key);
  ensureNoteAfter(editBtn, key);
}

function ensureEditAfter(element, addr) {
  // For anchors: keep the edit button INSIDE the anchor
  if (element && element.tagName === 'A') {
    // Remove any legacy sibling edit button
    const sib = element.nextElementSibling;
    if (sib && sib.classList && sib.classList.contains('explabel-edit')) {
      try { sib.remove(); } catch (_) {}
    }
    // Reuse existing inner edit if present
    let inner = element.querySelector('.explabel-edit');
    if (inner) {
      if (inner.dataset.addr !== addr) inner.dataset.addr = addr;
      ensureEditIcon(inner);
      return inner;
    }
    const btn = createEditButton(addr);
    element.appendChild(btn);
    return btn;
  }
  // Fallback (non-anchor): insert adjacent
  const next = element.nextElementSibling;
  if (next && next.classList && next.classList.contains('explabel-edit') && next.dataset.addr === addr) {
    return next;
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

function replaceTextNodesInRoot(root) {
  const MAX_NODES = 200;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.parentElement) return NodeFilter.FILTER_REJECT;
      const tag = n.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (n.parentElement.closest('a')) return NodeFilter.FILTER_REJECT;
      if (n.parentElement.closest('.explabel-wrap-short')) return NodeFilter.FILTER_REJECT;
      if (n.parentElement.closest('.explabel-wrap-full')) return NodeFilter.FILTER_REJECT;
      return /(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{4,20}(?:…|\.{3})[0-9a-fA-F]{4,20})/.test(n.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  const toProcess = [];
  let node; let counter = 0;
  while ((node = walker.nextNode())) {
    toProcess.push(node);
    if (++counter >= MAX_NODES) break;
  }
  toProcess.forEach(n => replaceMatchesInTextNode(n));
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
    const editBtn = wrap.querySelector('.explabel-edit'); if (editBtn) ensureNoteAfter(editBtn, key);
    
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
    const editBtn = wrap.querySelector('.explabel-edit'); if (editBtn) ensureNoteAfter(editBtn, full);

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
      } else { ensureEditIcon(editBtn); editBtn.dataset.addr = key; }
      ensureNoteAfter(editBtn, key);
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
    } else {
      if (editBtn.dataset.addr !== key) editBtn.dataset.addr = key;
      ensureEditIcon(editBtn);
    }
    ensureNoteAfter(editBtn, key);
  });
}

function createEditButton(addr) {
  const b = document.createElement('span');
  b.className = 'explabel-edit';
  b.dataset.addr = addr;
  b.innerHTML = getEditIconSvg();
  b.title = 'Edit / OSINT';
  b.addEventListener('click', onEditClick);
  return b;
}

function ensureEditIcon(el){ if (el) el.innerHTML = getEditIconSvg(); }

function getEditIconSvg(){
  return '<svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g><path fill="none" d="M0 0h24v24H0z"/><path d="M15.728 9.686l-1.414-1.414L5 17.586V19h1.414l9.314-9.314zm1.414-1.414l1.414-1.414-1.414-1.414-1.414 1.414 1.414 1.414zM7.242 21H3v-4.243L16.435 3.322a1 1 0 0 1 1.414 0l2.829 2.829a1 1 0 0 1 0 1.414L7.243 21z"/></g></svg>';
}

function getNote(addr){ const n = labels[addr]?.note; return (typeof n === 'string') ? n.trim() : ''; }

function createNoteIcon(addr){ const s=document.createElement('span'); s.className='explabel-note'; s.dataset.addr=addr; s.title='Note'; s.innerHTML=getNoteIconSvg(); return s; }

function ensureNoteIcon(el){ if (el) el.innerHTML = getNoteIconSvg(); }

function getNoteIconSvg(){
  return '<svg width="16" height="16" viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg"><path d="m1783.68 1468.235-315.445 315.445v-315.445h315.445Zm-541.327-338.823v112.94h-903.53v-112.94h903.53Zm338.936-338.824V903.53H338.824V790.59h1242.465ZM621.176 0c93.403 0 169.412 76.01 169.412 169.412 0 26.09-6.437 50.484-16.94 72.62L999.98 468.255l-79.962 79.962-226.221-226.334c-22.137 10.504-46.532 16.942-72.622 16.942-93.402 0-169.411-76.01-169.411-169.412C451.765 76.009 527.775 0 621.176 0Zm395.295 225.882v112.942h790.588v1016.47h-451.765v451.765H112.941V338.824h225.883V225.882H0V1920h1421.478c45.176 0 87.755-17.619 119.717-49.581l329.224-329.11c31.962-32.076 49.581-74.655 49.581-119.831V225.882h-903.53Z" fill="currentColor" fill-rule="evenodd"/></svg>';
}

function ensureNoteAfter(refEl, addr){
  const has = !!getNote(addr);
  // If refEl is inside an anchor, place the note icon after the anchor (outside link)
  let container = refEl;
  const anchor = refEl && refEl.closest && refEl.closest('a');
  if (anchor && anchor.contains(refEl)) container = anchor;
  const next = container && container.nextElementSibling;
  const isNote = next && next.classList && next.classList.contains('explabel-note') && next.dataset.addr===addr;
  if (has){
    if (!isNote){ const icon=createNoteIcon(addr); container.insertAdjacentElement('afterend', icon); }
    else { ensureNoteIcon(next); }
  } else {
    if (isNote){ try { next.remove(); } catch (_) {} }
  }
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

function onTipHover(e){
  const t = e.target.closest('.explabel-edit, .explabel-label, .explabel-note');
  if (!t){ hideTip(); return; }
  const isNoteIcon = t.classList && t.classList.contains('explabel-note');
  if (!isNoteIcon && !(e.shiftKey || explabelShiftDown)) { hideTip(); return; }
  const holder = t.closest('[data-addr]');
  const addr = holder?.dataset?.addr;
  if (!addr){ hideTip(); return; }
  const note = getNote(addr);
  if (!note){ hideTip(); return; }
  const first = note.split(/\r?\n/)[0] || '';
  const text = first.length>120 ? first.slice(0,120)+'…' : first;
  showTipNear(t, text);
}

function showTipNear(anchorEl, text){ if (!explabelTip){ const d=document.createElement('div'); d.className='explabel-tooltip'; explabelTip=d; document.body.appendChild(d); } explabelTip.textContent=text; const r=anchorEl.getBoundingClientRect(); explabelTip.style.top=(r.bottom+8)+'px'; const rect=explabelTip.getBoundingClientRect(); let left=r.left; const maxLeft=window.innerWidth-rect.width-8; if (left>maxLeft) left=maxLeft; if (left<8) left=8; explabelTip.style.left=left+'px'; }

function hideTip(){ if (explabelTip && explabelTip.isConnected){ explabelTip.remove(); } explabelTip=null; }
