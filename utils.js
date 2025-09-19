// utils.js - Shared utility functions for address handling and OSINT patterns

// Validate if a string is a valid Ethereum address (0x followed by 40 hex chars)
function isValidAddr(a) {
  if (!a) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

// Extract and normalize an Ethereum address (lowercase, no ronin handling)
function normalize(a) {
  if (!a) return '';
  const s = String(a).trim();
  const m = s.match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0].toLowerCase() : '';
}

// Extract an Ethereum address from common URL patterns
function extractAddressFromUrl(url) {
  if (!url) return '';
  
  // Path pattern: /address/0x... or /token/0x... or /account/0x...
  let m = url.match(/\/(address|token|account)\/(0x[0-9a-fA-F]{40})/);
  if (m) return m[2];
  
  // Query pattern: ?a=0x... or ?address=0x... or ?addr=0x...
  m = url.match(/[?&#](a|address|addr)=?(0x[0-9a-fA-F]{40})/);
  if (m) return m[2];
  
  return '';
}

// Default OSINT sources with {} placeholders
function defaultOsintSources() {
  return [
    { name: 'Arkham', pattern: 'https://intel.arkm.com/explorer/address/{}' },
    { name: 'DeBank', pattern: 'https://debank.com/profile/{}' },
  ];
}

// Convert a sample URL into a pattern with {} placeholder
function toPattern(sample) {
  let p = (sample || '').trim();
  if (!p) return '';
  
  // Ensure https:// scheme if missing
  if (!/^https?:\/\//i.test(p)) p = 'https://' + p;
  
  // If already contains {}, return as-is
  if (p.includes('{}')) return p;
  
  // Replace explicit 0x40 with {}
  const addrRe = /(0x[0-9a-fA-F]{40})/;
  if (addrRe.test(p)) return p.replace(addrRe, '{}');
  
  // Replace value of ?a|addr|address= with {}
  const qParamRe = /([?&](?:a|addr|address)=)[^&#]*/i;
  if (qParamRe.test(p)) return p.replace(qParamRe, '$1{}');
  
  // Replace path segment after /address|/token|/account with {}
  const pathRe = /(\/)(address|token|account)(\/)[^/?#]+/i;
  if (pathRe.test(p)) return p.replace(pathRe, '$1$2$3{}');
  
  // Fallback: append '/{}' to the end
  return p.replace(/\/*$/, '/') + '{}';
}

// Build a URL by replacing {} with the normalized address
function buildOsintUrl(sampleOrPattern, addr) {
  const norm = normalize(addr);
  if (!norm) return '';
  
  const pat = toPattern(sampleOrPattern || '');
  if (!pat) return '';
  
  return pat.replace('{}', norm);
}
