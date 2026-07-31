// VERAQIS Studio — shared DOM helpers.
//
// Every helper builds nodes and sets textContent. There is deliberately no
// function here that accepts markup, so no untrusted string can become HTML.

export const $ = (id, root = document) => root.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el('div', {class:'x', 'aria-live':'polite'}, 'text' | node | [children]) */
export function el(tag, attrs = {}, children = null) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = String(dv);
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k === 'oninput') n.addEventListener('input', v);
    else if (k === 'onchange') n.addEventListener('change', v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, String(v));
  }
  append(n, children);
  return n;
}

export function append(parent, children) {
  if (children === null || children === undefined) return parent;
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c)) : c);
  }
  return parent;
}

export function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

export function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return String(iso).slice(0, 19).replace('T', ' '); }
}

/** Screen-reader announcements, throttled so progress does not flood output. */
export function makeAnnouncer(node, minIntervalMs = 900) {
  let last = 0, pending = null, timer = null;
  return (text, force = false) => {
    if (!node) return;
    const now = Date.now();
    if (force || now - last >= minIntervalMs) {
      last = now; node.textContent = text; pending = null;
      if (timer) { clearTimeout(timer); timer = null; }
    } else {
      pending = text;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (pending !== null) { last = Date.now(); node.textContent = pending; pending = null; }
        }, minIntervalMs - (now - last));
      }
    }
  };
}

/** Render a typed StudioError into a container, with expandable detail. */
export function renderError(container, err) {
  clear(container);
  container.hidden = false;
  container.appendChild(el('p', { class: 'st-err-msg', text: err.userMessage || 'Something went wrong.' }));
  if (err.action) container.appendChild(el('p', { class: 'note', text: err.action }));
  if (err.detail || err.code) {
    const d = el('details', { class: 'st-err-detail' });
    d.appendChild(el('summary', { text: 'Technical details' }));
    const lines = [`code: ${err.code || 'UNKNOWN'}`];
    if (err.stage) lines.push(`stage: ${err.stage}`);
    if (Number.isFinite(err.offset)) lines.push(`offset: ${err.offset}`);
    if (err.detail) lines.push(`detail: ${err.detail}`);
    d.appendChild(el('pre', { text: lines.join('\n') }));
    container.appendChild(d);
  }
}

/** Trigger a download of text content without touching the network. */
export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next turn: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** A status pill carrying glyph + text, never colour alone. */
const GLYPH = {
  VERIFIED: '✓', STRUCTURALLY_VALID: '≡', POTENTIALLY_RECOVERABLE: '△',
  DAMAGED: '✕', UNKNOWN: '?',
};
export function statusPill(status, label) {
  const span = el('span', { class: 'zc-status zc-' + String(status).toLowerCase().replace(/_/g, '-') });
  span.appendChild(el('span', { class: 'zc-glyph', 'aria-hidden': 'true', text: GLYPH[status] || '?' }));
  span.appendChild(document.createTextNode(' ' + (label || status)));
  return span;
}
