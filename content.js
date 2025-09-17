const LABELS_KEY = 'labels';
let labels = {};

init();

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
      return /0x[0-9a-fA-F]{40}/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const toProcess = [];
  let node; while ((node = walker.nextNode())) toProcess.push(node);
  toProcess.forEach(n => replaceMatchesInTextNode(n));
}

function replaceMatchesInTextNode(textNode) {
  const text = textNode.nodeValue;
  const re = /0x[0-9a-fA-F]{40}/g;
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
  if (!changed) return;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  textNode.parentNode.replaceChild(frag, textNode);
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

function extractAddressFromUrl(url) {
  if (!url) return '';
  const m = url.match(/\/(address|token|account)\/(ronin:[0-9a-fA-F]{40}|0x[0-9a-fA-F]{40})/);
  return m ? m[2] : '';
}

function normalize(a) {
  if (!a) return '';
  let s = String(a).trim();
  if (s.toLowerCase().startsWith('ronin:')) s = '0x' + s.slice(6);
  const m = s.match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0].toLowerCase() : '';
}