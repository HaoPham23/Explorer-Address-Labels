const LABELS_KEY = 'labels';
let labels = {};

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
  await loadLabels();
  annotatePage();
  const observer = new MutationObserver(() => annotatePage());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LABELS_KEY]) {
      labels = changes[LABELS_KEY].newValue || {};
      annotatePage();
    }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'labelsUpdated') {
      loadLabels().then(annotatePage);
    }
  });
}

async function loadLabels() {
  const res = await chrome.storage.local.get(LABELS_KEY);
  labels = res[LABELS_KEY] || {};
}

function annotatePage() {
  updateExistingLabelSpans();
  updateExistingShortWrappers();
  replaceAnchorTexts();
  replaceTextNodes();
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
      if (a.textContent !== label) a.textContent = label;
      a.title = addr;
    } else if (a.dataset.explabelOrig) {
      // label removed; restore original
      a.textContent = a.dataset.explabelOrig;
      delete a.dataset.explabelOrig;
      delete a.dataset.addr;
      a.removeAttribute('title');
    }
  });
}

function replaceTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.parentElement) return NodeFilter.FILTER_REJECT;
      // Skip inside script/style and elements we already labeled
      const tag = n.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (n.parentElement.closest('a')) return NodeFilter.FILTER_REJECT; // anchors handled separately
      if (n.parentElement.closest('.explabel-wrap-short')) return NodeFilter.FILTER_REJECT;
      return /(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{4,20}(?:…|\.{3})[0-9a-fA-F]{4,20})/.test(n.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  const toProcess = [];
  let node; while ((node = walker.nextNode())) toProcess.push(node);
  toProcess.forEach(n => replaceMatchesInTextNode(n));
}

// ---------- replacement helpers ----------

function replaceMatchesInTextNode(textNode) {
  if (replaceFullAddresses(textNode)) return;
  replaceShortAddresses(textNode);
}

function replaceFullAddresses(textNode) {
  const text = textNode.nodeValue;
  const re = /(0x[0-9a-fA-F]{40})/g;
  let m, last = 0, changed = false;
  const frag = document.createDocumentFragment();
  while ((m = re.exec(text)) !== null) {
    const addr = m[0];
    const key = normalize(addr);
    const label = labels[key]?.label;
    if (!label) continue;
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const span = document.createElement('span');
    span.className = 'explabel-label';
    span.dataset.addr = key;
    span.dataset.original = addr;
    span.textContent = label;
    span.title = addr;
    frag.appendChild(span);
    last = re.lastIndex;
    changed = true;
  }
  if (!changed) return false;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  textNode.parentNode.replaceChild(frag, textNode);
  return true;
}

function replaceShortAddresses(textNode) {
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

    frag.appendChild(wrap);
    last = reShort.lastIndex;
    changed = true;
  }
  if (!changed) return false;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  textNode.parentNode.replaceChild(frag, textNode);
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
    } else {
      // remove wrapper entirely and restore original shortened text
      const orig = wrap.dataset.original || wrap.textContent;
      const n = document.createTextNode(orig);
      wrap.replaceWith(n);
    }
  });
}

function extractAddressFromUrl(url) {
  if (!url) return '';
  // Path forms like /address/<addr> or /token/<addr>
  let m = url.match(/\/(address|token|account)\/(0x[0-9a-fA-F]{40})/);
  if (m) return m[2];
  // Query-param forms ?a=<addr>, ?address=<addr>, ?addr=<addr>
  m = url.match(/[?&#](a|address|addr)=?(0x[0-9a-fA-F]{40})/);
  return m ? m[2] : '';
}

function normalize(a) {
  if (!a) return '';
  let s = String(a).trim();
  if (s.toLowerCase().startsWith('ronin:')) s = '0x' + s.slice(6);
  const m = s.match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0].toLowerCase() : '';
}