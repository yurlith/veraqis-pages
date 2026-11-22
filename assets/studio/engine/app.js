// VERAQIS Studio — the full engine page.
//
// Every function of the VERAQIS engine, free, on this device. The engine runs in
// a worker (engine-worker.js); this file is the page around it: the files you
// add, one form per function, and the results with their downloads. Files are
// handed to the worker as File objects and read in place — never uploaded.
import { GROUPS, OPS } from './ops.js';
import { buildZip } from './zip.js';

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}
const fmtBytes = (n) => {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; let x = n;
  do { x /= 1024; i++; } while (x >= 1024 && i < u.length - 1);
  return `${x.toFixed(x < 10 ? 2 : 1)} ${u[i]}`;
};
const secs = (ms) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
const human = (k) => { const s = String(k).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
const base = (p) => String(p).split('/').pop();

function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name || 'download' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ------------------------------------------------------------- the engine
class Engine {
  constructor(onState) {
    this.onState = onState;
    this.seq = 0;
    this.pending = new Map();
    this.start();
  }
  start() {
    this.worker = new Worker('/studio/engine-worker.js', { type: 'module', name: 'veraqis-engine' });
    this.worker.onmessage = (e) => {
      const m = e.data || {};
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'failed') p.reject(new Error(m.message)); else p.resolve(m);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      const err = new Error(e.message || 'The engine could not start in this browser.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.onState('failed', err.message);
    };
    this.onState('loading');
    this.ready = this.call({ type: 'init' }).then(
      (m) => { this.onState('ready', m.ms); return m; },
      (err) => { this.onState('failed', err.message); throw err; },
    );
  }
  call(msg) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }
  stop() {
    this.worker.terminate();
    const err = new Error('Stopped.');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.start();
  }
}

// ------------------------------------------------------------- your files
const pool = [];
let nextId = 1;
const listeners = new Set();
const poolChanged = () => { renderPool(); for (const fn of listeners) fn(); };

function uniqueName(name) {
  const taken = new Set(pool.map((p) => p.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) { const n = `${stem} (${i})${ext}`; if (!taken.has(n)) return n; }
}

function addFile(file) {
  const item = { id: nextId++, kind: 'file', name: uniqueName(file.name), file, size: file.size };
  pool.push(item);
  return item;
}

// entries: [{ rel: 'Folder/sub/a.txt', file }]
function addFolderEntries(entries) {
  const groups = new Map();
  for (const { rel, file } of entries) {
    const parts = rel.split('/').filter(Boolean);
    if (parts.length < 2) { addFile(file); continue; }
    const top = parts.shift();
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push({ rel: parts.join('/'), file });
  }
  for (const [name, files] of groups) {
    pool.push({ id: nextId++, kind: 'folder', name: uniqueName(name), files, size: files.reduce((n, f) => n + f.file.size, 0) });
  }
}

function readEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => { out.push({ rel: prefix + file.name, file }); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const next = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of all) await readEntry(child, prefix + entry.name + '/', out);
          resolve();
        } else { all.push(...batch); next(); }
      }, () => resolve());
      next();
    } else resolve();
  });
}

async function addDropped(dt) {
  const items = Array.from(dt.items || []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (entries.length && entries.every(Boolean)) {
    for (const entry of entries) {
      if (entry.isDirectory) { const out = []; await readEntry(entry, '', out); addFolderEntries(out); }
      else { await new Promise((r) => entry.file((f) => { addFile(f); r(); }, () => r())); }
    }
  } else {
    for (const f of dt.files) addFile(f);
  }
  poolChanged();
}

function renderPool() {
  const list = $('#ex-pool');
  list.replaceChildren();
  if (!pool.length) {
    list.append(el('li', { class: 'ex-pool-empty' }, 'No files yet. Add the files you want to work on — they stay on this device.'));
  }
  for (const item of pool) {
    const meta = item.kind === 'folder' ? `folder · ${item.files.length} file${item.files.length === 1 ? '' : 's'} · ${fmtBytes(item.size)}` : fmtBytes(item.size);
    list.append(el('li', { class: 'ex-pool-item' },
      el('span', { class: 'ex-pool-icon', 'aria-hidden': 'true' }, item.kind === 'folder' ? '▣' : '▤'),
      el('span', { class: 'ex-pool-name' }, item.name),
      el('span', { class: 'ex-pool-meta' }, meta),
      el('button', { type: 'button', class: 'ex-x', 'aria-label': `Remove ${item.name}`, onclick: () => { pool.splice(pool.indexOf(item), 1); poolChanged(); } }, '×')));
  }
  $('#ex-pool-clear').hidden = !pool.length;
}

// Picks for one form: file / folder selects that follow the pool.
function poolSelect(field, kind) {
  const select = el('select', { id: field.id, name: field.key });
  const fill = () => {
    const prev = select.value;
    select.replaceChildren();
    const items = pool.filter((p) => p.kind === kind);
    if (field.optional || !items.length) select.append(el('option', { value: '' }, items.length ? '— none —' : kind === 'folder' ? 'Add a folder above first' : 'Add a file above first'));
    for (const p of items) select.append(el('option', { value: String(p.id) }, p.name));
    if (prev && items.some((p) => String(p.id) === prev)) select.value = prev;
    else if (!field.optional && field.prefer) { const hit = items.find((p) => field.prefer.test(p.name)); if (hit) select.value = String(hit.id); }
    else if (field.optional) select.value = '';
  };
  fill();
  listeners.add(fill);
  return select;
}

const helpers = {
  file(id) {
    const item = pool.find((p) => String(p.id) === String(id) && p.kind === 'file');
    if (!item) throw new Error('Choose a file first — add it under “Your files”.');
    return { name: item.name, file: item.file, size: item.size };
  },
  optFile(id) { return id ? helpers.file(id) : null; },
  folder(id) {
    const item = pool.find((p) => String(p.id) === String(id) && p.kind === 'folder');
    if (!item) throw new Error('Choose a folder first — use “Add a folder” under “Your files”.');
    return { name: item.name, files: item.files };
  },
};

// ------------------------------------------------------------------ forms
function control(op, f) {
  const id = `ex-${op.id}-${f.key}`;
  const field = { ...f, id };
  let input;
  if (f.type === 'file') input = poolSelect(field, 'file');
  else if (f.type === 'folder') input = poolSelect(field, 'folder');
  else if (f.type === 'select') input = el('select', { id, name: f.key }, f.options.map(([v, l]) => el('option', { value: v }, l)));
  else if (f.type === 'check') {
    return el('p', { class: 'ex-field ex-check' }, el('label', {}, el('input', { type: 'checkbox', id, name: f.key }), ' ', f.label));
  } else if (f.type === 'number') input = el('input', { type: 'number', id, name: f.key, value: f.value, min: f.min, max: f.max, step: f.step });
  else if (f.type === 'password') input = el('input', { type: 'password', id, name: f.key, autocomplete: 'off', spellcheck: 'false' });
  else input = el('input', { type: 'text', id, name: f.key, placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
  return el('p', { class: 'ex-field' }, el('label', { for: id }, f.label), input);
}

function readValues(op, form) {
  const v = {};
  for (const f of op.fields || []) {
    const input = form.querySelector(`[name="${f.key}"]`);
    v[f.key] = f.type === 'check' ? input.checked : input.value;
  }
  return v;
}

// ---------------------------------------------------------------- results
const TIER_WORDS = { pro: 'every function open (free web edition)', fleet: 'every function open (free web edition)' };

function scalarText(k, v) {
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if ((k === 'tier' || k === 'license_tier') && TIER_WORDS[v]) return TIER_WORDS[v];
  if (typeof v === 'number' && /(bytes|size)$/.test(k) && v > 1023) return `${fmtBytes(v)} (${v.toLocaleString('en')} bytes)`;
  return String(v);
}

function factsTable(obj) {
  const rows = [];
  const skip = new Set(['result', 'listing', 'schema_version', 'operation_id', 'content']);
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k) || v == null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      if (v.every((x) => x === null || typeof x !== 'object')) rows.push([human(k), v.slice(0, 10).join(', ') + (v.length > 10 ? ` … (${v.length} in all)` : '')]);
      else rows.push([human(k), `${v.length} item${v.length === 1 ? '' : 's'} (listed below)`]);
    } else if (typeof v === 'object') {
      // Two levels of nesting are common (e.g. a salvage summary inside the
      // output summary); a repeated key is not printed twice.
      const walk = (label, o, depth) => {
        for (const [k2, v2] of Object.entries(o)) {
          if (v2 == null) continue;
          const name = k2 === label.split(' · ').pop().toLowerCase() ? label : `${label} · ${k2.replace(/_/g, ' ')}`;
          if (typeof v2 === 'object' && !Array.isArray(v2)) { if (depth < 2) walk(name, v2, depth + 1); }
          else if (!Array.isArray(v2)) rows.push([name, scalarText(k2, v2)]);
        }
      };
      walk(human(k), v, 1);
    } else {
      rows.push([human(k), scalarText(k, v)]);
    }
  }
  if (!rows.length) return null;
  return el('div', { class: 'table-scroll' }, el('table', { class: 'ex-facts' }, el('tbody', {},
    rows.map(([k, v]) => el('tr', {}, el('th', { scope: 'row' }, k), el('td', {}, v))))));
}

function arrayTables(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v) || !v.length || k === 'listing' || v.every((x) => x === null || typeof x !== 'object')) continue;
    out.push(objectTable(human(k), v));
  }
  return out;
}

function objectTable(title, rows, extraColumn) {
  const cols = [];
  for (const r of rows.slice(0, 30)) {
    for (const [k, v] of Object.entries(r || {})) {
      if (cols.length >= 7) break;
      if (!cols.includes(k) && (v === null || typeof v !== 'object' || Array.isArray(v))) cols.push(k);
    }
  }
  const shown = rows.slice(0, 500);
  const cell = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return String(v);
  };
  return el('div', { class: 'ex-table' },
    el('h4', {}, `${title} (${rows.length})`),
    el('div', { class: 'table-scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, cols.map((c) => el('th', { scope: 'col' }, c.replace(/_/g, ' '))), extraColumn ? el('th', { scope: 'col' }, '') : null)),
      el('tbody', {}, shown.map((r) => el('tr', {}, cols.map((c) => el('td', {}, cell(r[c]))), extraColumn ? el('td', {}, extraColumn(r)) : null))))),
    rows.length > shown.length ? el('p', { class: 'note' }, `Showing the first ${shown.length}. The full list is in the full response below.`) : null);
}

function filesBlock(files, zipName) {
  if (!files || !files.length) return null;
  const items = files.map((f) => ({ name: f.path, bytes: new Uint8Array(f.bytes) }));
  const total = items.reduce((n, f) => n + f.bytes.length, 0);
  return el('div', { class: 'ex-files' },
    el('h4', {}, `Files produced (${items.length}, ${fmtBytes(total)})`),
    el('ul', {}, items.map((f) => el('li', {},
      el('span', { class: 'mono' }, f.name), ' ', el('span', { class: 'note' }, fmtBytes(f.bytes.length)), ' ',
      el('button', { type: 'button', class: 'btn ghost ex-sm', onclick: () => download(base(f.name), f.bytes) }, 'Download')))),
    items.length > 1 ? el('p', {}, el('button', {
      type: 'button', class: 'btn primary ex-sm',
      onclick: () => { try { download(zipName || 'veraqis-results.zip', buildZip(items)); } catch (err) { alertIn(err.message); } },
    }, 'Download all as .zip')) : null);
}

function alertIn(message) {
  const live = $('#ex-live');
  live.textContent = message;
}

function errorView(r) {
  const msg = r.message || (r.error && (r.error.message || r.error.kind)) || 'The engine returned an error.';
  return el('div', { class: 'callout warn' },
    el('strong', {}, r.kind ? human(r.kind) + ': ' : 'Not done: '), msg,
    r.hint ? el('p', { class: 'note' }, r.hint) : null);
}

function isError(r) { return !r || r.result === 'error' || (!!r.error && typeof r.error === 'object'); }

function rawJson(envelope) {
  return el('details', { class: 'ex-raw' }, el('summary', {}, 'Full response (JSON)'),
    el('pre', {}, JSON.stringify(envelope, null, 2)),
    el('button', { type: 'button', class: 'btn ghost ex-sm', onclick: () => download('veraqis-response.json', JSON.stringify(envelope, null, 2), 'application/json') }, 'Download the response'));
}

function resultView(res, opts = {}) {
  const r = res.envelope && res.envelope.response;
  const box = el('div', { class: 'ex-result-body' });
  if (isError(r)) {
    box.append(errorView(r || {}));
  } else {
    box.append(el('p', { class: 'ex-done' }, `Done in ${secs(res.ms)}.`));
    if (opts.before) box.append(...[].concat(opts.before(r)).filter(Boolean));
    if (r.result === 'rendered' && typeof r.content === 'string') {
      box.append(el('pre', { class: 'ex-pre' }, r.content));
      const ext = { console: 'txt', md: 'md', html: 'html', json: 'json' }[r.format] || 'txt';
      box.append(el('p', {}, el('button', { type: 'button', class: 'btn ghost ex-sm', onclick: () => download(`${opts.name || 'report'}.report.${ext}`, r.content, 'text/plain') }, 'Download this report')));
    } else if (r.result === 'preview' && typeof r.content === 'string') {
      box.append(el('pre', { class: 'ex-pre' }, r.content));
    }
    const facts = factsTable(r);
    if (facts) box.append(facts);
    if (!opts.noTables) box.append(...arrayTables(r));
  }
  const files = filesBlock(res.files, opts.zipName);
  if (files) box.append(files);
  box.append(rawJson(res.envelope));
  return box;
}

// ------------------------------------------------------------------ running
let engine;
let busy = false;

async function runJob(card, job, opts = {}) {
  const out = card.querySelector('.ex-result');
  if (busy) { out.replaceChildren(el('p', { class: 'callout info' }, 'Another function is still running — wait for it or stop it first.')); return null; }
  busy = true;
  document.body.classList.add('ex-busy');
  const busyMark = document.getElementById('studio-busy'); // the update prompt waits while this shows
  if (busyMark) busyMark.hidden = false;
  const started = performance.now();
  const timer = el('span', {}, '0 s');
  const tick = setInterval(() => { timer.textContent = secs(performance.now() - started); }, 250);
  out.replaceChildren(el('div', { class: 'ex-running', role: 'status' },
    el('span', { class: 'ex-spin', 'aria-hidden': 'true' }), ' Working… ', timer, ' ',
    el('button', { type: 'button', class: 'btn ghost ex-sm', onclick: () => engine.stop() }, 'Stop')));
  try {
    await engine.ready;
    const res = await engine.call({ type: 'run', engine: job.engine || 'phx', request: job.request, inputs: job.inputs || [], writable: !!job.writable, mode: job.mode, archive: job.archive, password: job.password, selected: job.selected });
    out.replaceChildren(opts.view ? opts.view(res) : resultView(res, { zipName: job.zipName, name: job.name }));
    $('#ex-live').textContent = 'Finished.';
    return res;
  } catch (err) {
    out.replaceChildren(el('div', { class: 'callout warn' }, el('strong', {}, 'Not done: '), err.message));
    return null;
  } finally {
    clearInterval(tick);
    busy = false;
    document.body.classList.remove('ex-busy');
    if (busyMark) busyMark.hidden = true;
  }
}

function formError(card, message) {
  card.querySelector('.ex-result').replaceChildren(el('div', { class: 'callout warn' }, message));
}

// ------------------------------------------------------- custom functions
const CUSTOM = {
  hub(op, body) {
    const fileF = { key: 'file', type: 'file', label: 'Damaged file' };
    const form = el('form', { class: 'ex-form' }, control(op, fileF),
      el('p', {}, el('button', { type: 'submit', class: 'btn primary' }, 'Find recovery options')));
    const options = el('div', { class: 'ex-hub' });
    body.append(form, options, el('div', { class: 'ex-result', 'aria-live': 'polite' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let f;
      try { f = helpers.file(readValues({ fields: [fileF] }, form).file); } catch (err) { formError(body, err.message); return; }
      const res = await runJob(body, { request: { op: 'recovery_preflight', source: '/in/' + f.name, experimental_enabled: showExperimental() }, inputs: [f] }, {
        view: (res) => resultView(res, { noTables: true }),
      });
      const r = res && res.envelope.response;
      options.replaceChildren();
      if (!r || isError(r)) return;
      const caps = (r.available_capabilities || []).filter((c) => !c.hidden || showExperimental());
      options.append(el('h4', {}, 'Methods for this file'));
      for (const c of caps) options.append(hubRow(body, f, c));
      if (!caps.length) options.append(el('p', { class: 'note' }, 'No recovery method applies to this file.'));
    });
  },

  inspect(op, body) {
    const fields = [{ key: 'file', type: 'file', label: 'Archive or document' }, { key: 'password', type: 'password', label: 'Password, only if it is encrypted (traditional ZIP)' }];
    const form = el('form', { class: 'ex-form' }, fields.map((f) => control(op, f)), el('p', {}, el('button', { type: 'submit', class: 'btn primary' }, 'Look inside')));
    const preview = el('div', { class: 'ex-preview' });
    body.append(form, el('div', { class: 'ex-result', 'aria-live': 'polite' }), preview);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let f; const v = readValues({ fields }, form);
      try { f = helpers.file(v.file); } catch (err) { formError(body, err.message); return; }
      preview.replaceChildren();
      const extra = v.password ? { password: v.password } : {};
      await runJob(body, { request: { op: 'inspect', path: '/in/' + f.name, ...extra }, inputs: [f] }, {
        view: (res) => {
          const r = res.envelope.response;
          if (isError(r) || !Array.isArray(r.nodes)) return resultView(res);
          const nodes = r.nodes.map((n) => ({ id: n.id, name: n.virtual_path || n.name, kind: n.kind, type: n.detected_type || '', size: n.declared_size != null ? fmtBytes(n.declared_size) : '', status: n.status, findings: (n.findings || []).length, _n: n }));
          return resultView(res, {
            noTables: true,
            before: () => objectTable('Contents', nodes.map(({ _n, ...rest }) => rest), (row) => (row.kind === 'file' ? el('button', {
              type: 'button', class: 'btn ghost ex-sm',
              onclick: async () => {
                const card = el('div', {}, el('div', { class: 'ex-result' }));
                preview.replaceChildren(el('h4', {}, `Preview: ${row.name}`), card);
                await runJob(card, { request: { op: 'inspect_preview', path: '/in/' + f.name, node_id: row.id, ...extra }, inputs: [f] });
              },
            }, 'Preview') : '')),
          });
        },
      });
    });
  },

  safe_extract(op, body) {
    const fields = [{ key: 'file', type: 'file', label: 'Archive' }, { key: 'password', type: 'password', label: 'Password, only if it is encrypted (traditional ZIP)' }];
    const form = el('form', { class: 'ex-form' }, fields.map((f) => control(op, f)), el('p', {}, el('button', { type: 'submit', class: 'btn primary' }, 'List safe entries')));
    const picker = el('div', { class: 'ex-picker' });
    body.append(form, picker, el('div', { class: 'ex-result', 'aria-live': 'polite' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let f; const v = readValues({ fields }, form);
      try { f = helpers.file(v.file); } catch (err) { formError(body, err.message); return; }
      const extra = v.password ? { password: v.password } : {};
      picker.replaceChildren();
      const res = await runJob(body, { request: { op: 'list_safe_entries', path: '/in/' + f.name, ...extra }, inputs: [f] }, { view: (res) => resultView(res, { noTables: true }) });
      const r = res && res.envelope.response;
      if (!r || isError(r) || !Array.isArray(r.entries)) return;
      picker.append(entryPicker(r.entries.map((x) => ({ name: x.name, size: x.size, note: x.compression })), 'Extract selected', async (names) => {
        await runJob(body, { request: { op: 'extract_safe_entries', path: '/in/' + f.name, output_dir: '/out/extracted', entries: names, ...extra }, inputs: [f], zipName: base(f.name) + '-extracted.zip' });
      }));
    });
  },

  rar(op, body) {
    const isRar = (p) => /\.(rar|r\d\d|part\d+\.rar)$/i.test(p.name);
    const fields = [
      { key: 'file', type: 'file', label: 'RAR archive (for several volumes, the first one)', prefer: /(\.part0*1\.rar|\.rar)$/i },
      { key: 'password', type: 'password', label: 'Password, only if it is encrypted' },
    ];
    const form = el('form', { class: 'ex-form' }, fields.map((f) => control(op, f)),
      el('p', { class: 'ex-buttons' },
        el('button', { type: 'submit', class: 'btn primary', value: 'list' }, 'List'),
        el('button', { type: 'submit', class: 'btn ghost', value: 'test' }, 'Test'),
        el('button', { type: 'submit', class: 'btn ghost', value: 'extract' }, 'Extract all')));
    const picker = el('div', { class: 'ex-picker' });
    body.append(form, picker, el('div', { class: 'ex-result', 'aria-live': 'polite' }),
      el('p', { class: 'note' }, 'RAR support uses UnRAR by Alexander Roshal, compiled to WebAssembly. Encrypted archives open only with the password you type here; nothing is guessed or stored.'));
    const job = (mode, f, password, selected) => ({
      engine: 'rar', mode, archive: f.name, password, selected,
      inputs: pool.filter((p) => p.kind === 'file' && (p.id === f.id || isRar(p))).map((p) => ({ name: p.name, file: p.file })),
      zipName: base(f.name).replace(/\.rar$/i, '') + '-extracted.zip',
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = (e.submitter && e.submitter.value) || 'list';
      const v = readValues({ fields }, form);
      let f;
      try { f = helpers.file(v.file); f.id = Number(v.file); } catch (err) { formError(body, err.message); return; }
      picker.replaceChildren();
      const res = await runJob(body, job(mode, f, v.password, []), { view: (res) => rarView(res) });
      const r = res && res.envelope.response;
      if (mode === 'list' && r && Array.isArray(r.entries) && r.entries.some((x) => !x.dir)) {
        picker.append(entryPicker(r.entries.filter((x) => !x.dir).map((x) => ({ name: x.name, size: x.size, note: x.encrypted ? 'encrypted' : '' })), 'Extract selected', async (names) => {
          await runJob(body, job('extract', f, v.password, names), { view: (res) => rarView(res) });
        }));
      }
    });
  },

  capabilities(op, body) {
    body.append(el('p', {}, el('button', {
      type: 'button', class: 'btn primary',
      onclick: () => runJob(body, { request: { op: 'capabilities' } }, {
        view: (res) => {
          const r = res.envelope.response;
          if (isError(r)) return resultView(res);
          const caps = (r.capabilities || []).map((c) => ({ title: c.title, lifecycle: c.lifecycle, evidence: c.evidence_level, formats: (c.supported_formats || []).join(', '), description: c.description }));
          return resultView(res, { noTables: true, before: () => objectTable('Recovery methods', caps) });
        },
      }),
    }, 'Show')), el('div', { class: 'ex-result', 'aria-live': 'polite' }));
  },

  simple(op, body) {
    body.append(el('p', {}, el('button', { type: 'button', class: 'btn primary', onclick: () => runJob(body, { request: op.request }) }, 'Run')),
      el('div', { class: 'ex-result', 'aria-live': 'polite' }));
  },

  history(op, body) {
    let armed = false;
    const clear = el('button', {
      type: 'button', class: 'btn ghost',
      onclick: async () => {
        if (!armed) { armed = true; clear.textContent = 'Click again to clear the history'; setTimeout(() => { armed = false; clear.textContent = 'Clear history'; }, 4000); return; }
        armed = false; clear.textContent = 'Clear history';
        await runJob(body, { request: { op: 'history_clear' } });
      },
    }, 'Clear history');
    body.append(el('p', { class: 'ex-buttons' },
      el('button', { type: 'button', class: 'btn primary', onclick: () => runJob(body, { request: { op: 'history_summary', recent_limit: 50 } }) }, 'Show summary'), clear),
    el('div', { class: 'ex-result', 'aria-live': 'polite' }));
  },

  raw(op, body) {
    const ta = el('textarea', { id: 'ex-raw-request', rows: '6', spellcheck: 'false' }, '{ "op": "capabilities" }');
    const mountAll = el('input', { type: 'checkbox', id: 'ex-raw-mount', checked: true });
    body.append(el('p', { class: 'ex-field' }, el('label', { for: 'ex-raw-request' }, 'Request (the "request" object of a protocol-v1 envelope)'), ta),
      el('p', { class: 'ex-field ex-check' }, el('label', {}, mountAll, ' Give the engine all my files (each at /in/<name>; folders at /in/<folder>/…)')),
      el('p', {}, el('button', {
        type: 'button', class: 'btn primary',
        onclick: () => {
          let request;
          try { request = JSON.parse(ta.value); } catch (err) { formError(body, 'That is not valid JSON: ' + err.message); return; }
          const inputs = mountAll.checked ? pool.flatMap((p) => (p.kind === 'file' ? [{ name: p.name, file: p.file }] : p.files.map((x) => ({ name: p.name + '/' + x.rel, file: x.file })))) : [];
          runJob(body, { request, inputs });
        },
      }, 'Send')), el('div', { class: 'ex-result', 'aria-live': 'polite' }));
  },
};

function showExperimental() { const t = $('#ex-experimental'); return !!(t && t.checked); }

const HUB_MODE = (id) => (id === 'automatic_structural_repair' ? 'automatic'
  : id.startsWith('semantic_') ? 'semantic'
    : id.startsWith('salvage_') ? 'salvage'
      : id.startsWith('reconcile_') ? 'reconcile'
        : id === 'shield_restore' ? 'shield'
          : id === 'safe_archive_extract' ? 'safe_extract'
            : id.startsWith('xcr') ? 'xcr' : 'automatic');

function hubRow(card, f, c) {
  const row = el('div', { class: 'ex-hub-row' + (c.available ? '' : ' ex-off') });
  const extras = [];
  const op = { id: 'hub-' + c.id };
  let sidecarSel; let manifestSel; let indexSel;
  if (c.id === 'shield_restore') { sidecarSel = control(op, { key: 'sidecar', type: 'file', label: 'Its repair data (.phxs)', prefer: /\.phxs$/i }); extras.push(sidecarSel); }
  if (HUB_MODE(c.id) === 'xcr') {
    manifestSel = control(op, { key: 'manifest', type: 'file', label: 'Region manifest (.phxx.json)', prefer: /\.phxx\.json$/i });
    indexSel = control(op, { key: 'index', type: 'folder', label: 'Folder with your earlier copies' });
    extras.push(manifestSel, indexSel);
  }
  row.append(
    el('div', { class: 'ex-hub-head' },
      el('strong', {}, c.title), ' ',
      el('span', { class: 'tag' }, c.lifecycle), ' ',
      el('span', { class: 'tag' }, String(c.evidence_level || '').replace(/_/g, ' '))),
    c.available ? null : el('p', { class: 'note' }, c.reason_unavailable || 'Not available for this file.'),
    c.limitation ? el('p', { class: 'note' }, c.limitation) : null,
    ...extras);
  if (c.available) {
    row.append(el('p', {}, el('button', {
      type: 'button', class: 'btn primary ex-sm',
      onclick: async () => {
        const mode = HUB_MODE(c.id);
        const options = { mode };
        const inputs = [{ name: f.name, file: f.file }];
        try {
          if (mode === 'shield') { const s = helpers.file(sidecarSel.querySelector('select').value); options.sidecar = '/in/' + s.name; inputs.push(s); }
          if (mode === 'xcr') {
            const m = helpers.file(manifestSel.querySelector('select').value); const d = helpers.folder(indexSel.querySelector('select').value);
            options.owner_index = '/in/owner-index';
            inputs.push({ name: f.name + '.phxx.json', file: m.file }, ...d.files.map((x) => ({ name: 'owner-index/' + x.rel, file: x.file })));
          }
        } catch (err) { formError(card, err.message); return; }
        if (mode === 'safe_extract') {
          const listed = await runJob(card, { request: { op: 'list_safe_entries', path: '/in/' + f.name }, inputs: [f] });
          const r = listed && listed.envelope.response;
          if (!r || isError(r)) return;
          options.selected_entries = (r.entries || []).map((x) => x.name);
        }
        await runJob(card, { request: { op: 'recovery_execute', source: '/in/' + f.name, output_directory: '/out', capability: c.id, options }, inputs, zipName: base(f.name) + '-recovered.zip' });
      },
    }, 'Run this method')));
  }
  return row;
}

function entryPicker(entries, label, onRun) {
  const boxes = entries.map((x) => el('input', { type: 'checkbox', checked: true, value: x.name }));
  const all = el('input', { type: 'checkbox', checked: true, onchange: () => { for (const b of boxes) b.checked = all.checked; } });
  return el('div', { class: 'ex-entries' },
    el('h4', {}, `Entries (${entries.length})`),
    el('p', { class: 'ex-check' }, el('label', {}, all, ' Select all')),
    el('ul', {}, entries.slice(0, 2000).map((x, i) => el('li', {}, el('label', {}, boxes[i], ' ', el('span', { class: 'mono' }, x.name), ' ', el('span', { class: 'note' }, [fmtBytes(x.size), x.note].filter(Boolean).join(' · ')))))),
    entries.length > 2000 ? el('p', { class: 'note' }, 'Showing the first 2,000 entries; “Extract all” covers every entry.') : null,
    el('p', {}, el('button', {
      type: 'button', class: 'btn primary ex-sm',
      onclick: () => { const names = boxes.filter((b) => b.checked).map((b) => b.value); if (!names.length) return; onRun(names); },
    }, label)));
}

function rarView(res) {
  const r = res.envelope.response;
  const head = [];
  if (r.need_password) head.push(el('div', { class: 'callout warn' }, el('strong', {}, 'This archive is encrypted. '), 'Type its password and try again.'));
  else if (r.missing_volume) head.push(el('div', { class: 'callout warn' }, el('strong', {}, 'A volume is missing: '), base(r.missing_volume), '. Add every volume of the archive under “Your files”.'));
  else if (r.error_code) head.push(el('div', { class: 'callout warn' }, el('strong', {}, 'Stopped: '), r.error));
  else if (r.mode !== 'list') head.push(el('div', { class: r.ok ? 'callout ok' : 'callout warn' }, r.ok
    ? `${r.mode === 'test' ? 'Every entry decompressed and matched its checksum' : 'Extracted'}: ${r.entries_processed} file(s), ${fmtBytes(r.bytes)}.`
    : `${r.entries_failed} of ${r.entries_processed} file(s) failed their checksum. ${r.mode === 'extract' ? 'Damaged files are not kept.' : ''}`));
  const rows = (r.entries || []).map((x) => ({ name: x.name, size: x.dir ? 'folder' : fmtBytes(x.size), packed: x.dir ? '' : fmtBytes(x.packed), crc32: x.crc32, encrypted: x.encrypted, result: x.result || '' }));
  return resultView({ ...res, envelope: res.envelope }, {
    noTables: true,
    zipName: 'rar-extracted.zip',
    before: () => [...head, rows.length ? objectTable('Entries', rows) : null],
  });
}

function keygen(body) {
  const box = el('div', { class: 'ex-keygen' });
  const button = el('button', {
    type: 'button', class: 'btn ghost ex-sm',
    onclick: async () => {
      try {
        const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
        const seed = pkcs8.slice(pkcs8.length - 32);
        const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        const stamp = new Date().toISOString().slice(0, 10);
        const priv = new File([seed], `signing-${stamp}.ed25519`, { type: 'application/octet-stream' });
        const pubFile = new File([pub], `signing-${stamp}.ed25519.pub`, { type: 'application/octet-stream' });
        addFile(priv); addFile(pubFile); poolChanged();
        box.replaceChildren(el('div', { class: 'callout ok' },
          el('strong', {}, 'Key pair created and added to your files. '),
          'Keep the private key (.ed25519) secret; share the public key (.pub). ',
          el('button', { type: 'button', class: 'btn ghost ex-sm', onclick: () => download(priv.name, seed) }, 'Download private key'), ' ',
          el('button', { type: 'button', class: 'btn ghost ex-sm', onclick: () => download(pubFile.name, pub) }, 'Download public key')));
      } catch {
        box.replaceChildren(el('div', { class: 'callout warn' }, 'This browser cannot create Ed25519 keys. Use a 32-byte key file made elsewhere.'));
      }
    },
  }, 'Create a new key pair');
  body.append(el('p', { class: 'note' }, 'No key yet? ', button), box);
}

// --------------------------------------------------------------- the page
function opCard(op) {
  const body = el('div', { class: 'ex-op-body' });
  const card = el('details', { class: 'ex-op', id: 'fn-' + op.id, 'data-experimental': op.experimental ? '1' : null, 'data-advanced': op.advanced ? '1' : null },
    el('summary', {}, el('span', { class: 'ex-op-title' }, op.title, op.experimental ? el('span', { class: 'tag ex-exp' }, 'experimental') : null), el('span', { class: 'ex-op-desc' }, op.desc)),
    body);
  if (op.custom && CUSTOM[op.custom]) {
    CUSTOM[op.custom](op, body);
  } else {
    const form = el('form', { class: 'ex-form' },
      (op.fields || []).map((f) => control(op, f)),
      el('p', {}, el('button', { type: 'submit', class: 'btn primary' }, 'Run')));
    body.append(form);
    if (op.custom === 'keygen') keygen(body);
    body.append(el('div', { class: 'ex-result', 'aria-live': 'polite' }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let job;
      try { job = op.build(readValues(op, form), helpers); } catch (err) { formError(body, err.message); return; }
      runJob(body, job);
    });
  }
  return card;
}

function renderGroups() {
  const root = $('#ex-groups');
  const jump = $('#ex-jump');
  for (const g of GROUPS) {
    const ops = OPS.filter((o) => o.group === g.id);
    jump.append(el('a', { href: '#group-' + g.id, class: 'chip' }, g.title));
    root.append(el('section', { class: 'ex-group', id: 'group-' + g.id, 'aria-labelledby': 'h-' + g.id },
      el('h2', { id: 'h-' + g.id }, g.title),
      el('p', { class: 'note' }, g.blurb),
      ops.map(opCard)));
  }
}

function applyToggles() {
  document.body.classList.toggle('ex-show-exp', showExperimental());
  const adv = $('#ex-advanced');
  document.body.classList.toggle('ex-show-adv', !!(adv && adv.checked));
}

function setState(state, detail) {
  const s = $('#ex-status');
  s.className = 'ex-status ex-status--' + state;
  if (state === 'loading') s.textContent = 'Loading the engine (about 1 MB, once)…';
  else if (state === 'ready') s.textContent = `Engine ready — every function below runs on this device. Loaded in ${secs(detail || 0)}.`;
  else s.textContent = 'The engine could not start in this browser: ' + (detail || 'unknown error') + '. Try a current Chrome, Edge, Firefox or Safari.';
}

function init() {
  if (!('Worker' in window) || typeof WebAssembly !== 'object') { setState('failed', 'WebAssembly or workers are not available'); return; }
  renderGroups();
  renderPool();
  engine = new Engine(setState);
  const files = $('#ex-add-files');
  const folder = $('#ex-add-folder');
  $('#ex-pick-files').addEventListener('click', () => files.click());
  $('#ex-pick-folder').addEventListener('click', () => folder.click());
  files.addEventListener('change', () => { for (const f of files.files) addFile(f); files.value = ''; poolChanged(); });
  folder.addEventListener('change', () => { addFolderEntries(Array.from(folder.files).map((f) => ({ rel: f.webkitRelativePath || f.name, file: f }))); folder.value = ''; poolChanged(); });
  $('#ex-pool-clear').addEventListener('click', () => { pool.length = 0; poolChanged(); });
  const drop = $('#ex-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('ex-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('ex-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('ex-over'); addDropped(e.dataTransfer); });
  for (const id of ['#ex-experimental', '#ex-advanced']) $(id).addEventListener('change', applyToggles);
  applyToggles();
  if (location.hash.startsWith('#fn-')) { const d = document.getElementById(location.hash.slice(1)); if (d) d.open = true; }
  // For automated checks of this page: the same code path the buttons use.
  window.__veraqisEngine = {
    addFiles: (list) => { for (const f of list) addFile(f); poolChanged(); },
    addFolder: (entries) => { addFolderEntries(entries); poolChanged(); },
    pool: () => pool.map(({ id, kind, name, size }) => ({ id, kind, name, size })),
    ready: () => engine.ready,
  };
}

init();
