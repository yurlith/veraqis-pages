// VERAQIS Studio — full engine worker.
//
// Runs the complete VERAQIS (PHX) engine — compiled to WebAssembly from the same
// Rust source as the desktop and Android apps — plus UnRAR for RAR archives, off
// the page's main thread. Files arrive as File objects and are read where they
// are (WORKERFS): nothing is uploaded, and no copy is made unless an operation
// has to write next to its input. Each job answers with the engine's JSON
// envelope plus the bytes of every file the operation wrote.
//
// One job runs at a time, so a job owns three fixed directories:
//   /in    the user's files, read in place (read-only)
//   /work  a writable copy, only for operations that write beside their input
//   /out   everything the operation writes
// The engine's own history lives in /phx/history and is kept in this browser's
// IndexedDB ("veraqis-engine") between visits; nothing else is kept.
import createPhx from './phx_web.js';

const HISTORY_DIR = '/phx/history';
const DB_NAME = 'veraqis-engine';
const STORE = 'history';
const BLOCK = 4 * 1024 * 1024; // read-ahead block for files read in place
const MAX_BLOCKS = 8;          // at most 32 MiB of read-ahead held at once

let phx = null;
let unrar = null;
const quietLog = [];

const remember = (line) => { quietLog.push(String(line)); if (quietLog.length > 200) quietLog.shift(); };

// WORKERFS reads every request straight from the File. The engine reads in small
// pieces, so each piece used to cost a full round trip through FileReaderSync.
// Reading aligned 4 MiB blocks and serving small reads from them made analysis
// of a file read in place several times faster. Large reads still go direct.
function addReadAhead(M) {
  const ops = M.WORKERFS.stream_ops;
  const reader = new FileReaderSync();
  const blocks = new Map(); // "node:index" -> Uint8Array, oldest first
  const block = (node, index) => {
    const key = node.id + ':' + index;
    let bytes = blocks.get(key);
    if (bytes) { blocks.delete(key); blocks.set(key, bytes); return bytes; }
    const start = index * BLOCK;
    bytes = new Uint8Array(reader.readAsArrayBuffer(node.contents.slice(start, Math.min(node.size, start + BLOCK))));
    blocks.set(key, bytes);
    while (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value);
    return bytes;
  };
  ops.read = (stream, buffer, offset, length, position) => {
    const node = stream.node;
    if (position >= node.size) return 0;
    const want = Math.min(length, node.size - position);
    if (want >= BLOCK) {
      const ab = reader.readAsArrayBuffer(node.contents.slice(position, position + want));
      buffer.set(new Uint8Array(ab), offset);
      return want;
    }
    let done = 0;
    while (done < want) {
      const pos = position + done;
      const index = Math.floor(pos / BLOCK);
      const bytes = block(node, index);
      const from = pos - index * BLOCK;
      const n = Math.min(want - done, bytes.length - from);
      buffer.set(bytes.subarray(from, from + n), offset + done);
      done += n;
    }
    return want;
  };
  return () => blocks.clear();
}

function rmrf(FS, path) {
  let st;
  try { st = FS.lstat(path); } catch { return; }
  if (FS.isDir(st.mode)) {
    for (const n of FS.readdir(path)) if (n !== '.' && n !== '..') rmrf(FS, path + '/' + n);
    try { FS.rmdir(path); } catch { /* a mount point stays */ }
  } else {
    FS.unlink(path);
  }
}

function mkdirp(FS, path) {
  let p = '';
  for (const part of path.split('/').filter(Boolean)) {
    p += '/' + part;
    try { FS.mkdir(p); } catch { /* exists */ }
  }
}

function walk(FS, dir, out = []) {
  let names;
  try { names = FS.readdir(dir); } catch { return out; }
  for (const n of names) {
    if (n === '.' || n === '..') continue;
    const p = dir + '/' + n;
    const st = FS.lstat(p);
    if (FS.isDir(st.mode)) walk(FS, p, out);
    else if (FS.isFile(st.mode)) out.push(p); // links are never followed or returned
  }
  return out;
}

// Fresh /in, /work and /out for one job.
function prepare(M, inputs, writable) {
  const { FS } = M;
  try { FS.unmount('/in'); } catch { /* not mounted */ }
  for (const d of ['/in', '/out', '/work']) rmrf(FS, d);
  for (const d of ['/in', '/out', '/work']) mkdirp(FS, d);
  const copied = new Set();
  if (writable) {
    const reader = new FileReaderSync();
    for (const { name, file } of inputs) {
      const p = '/work/' + name;
      mkdirp(FS, p.slice(0, p.lastIndexOf('/')));
      FS.writeFile(p, new Uint8Array(reader.readAsArrayBuffer(file)));
      copied.add(p);
    }
  } else if (inputs.length) {
    FS.mount(M.WORKERFS, { blobs: inputs.map(({ name, file }) => ({ name, data: file })) }, '/in');
  }
  return copied;
}

// Every file the job wrote: all of /out, plus new files in /work.
function collect(M, copied) {
  const { FS } = M;
  const files = [];
  const transfer = [];
  const add = (path, rel) => {
    const bytes = FS.readFile(path);
    files.push({ path: rel, size: bytes.length, bytes: bytes.buffer });
    transfer.push(bytes.buffer);
  };
  for (const p of walk(FS, '/out')) add(p, p.slice('/out/'.length));
  for (const p of walk(FS, '/work')) if (!copied.has(p)) add(p, p.slice('/work/'.length));
  return { files, transfer };
}

function release(M) {
  const { FS } = M;
  try { FS.unmount('/in'); } catch { /* not mounted */ }
  for (const d of ['/out', '/work']) rmrf(FS, d);
  if (M.clearReadAhead) M.clearReadAhead();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function store(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function saveHistory(M) {
  try {
    const files = {};
    for (const p of walk(M.FS, HISTORY_DIR)) files[p.slice(HISTORY_DIR.length + 1)] = M.FS.readFile(p);
    const db = await openDb();
    await store(db, 'readwrite', (s) => s.put(files, 'files'));
    db.close();
  } catch (err) {
    remember('history not saved: ' + (err && err.message));
  }
}

async function restoreHistory(M) {
  try {
    const db = await openDb();
    const files = await store(db, 'readonly', (s) => s.get('files'));
    db.close();
    if (!files) return;
    for (const [rel, bytes] of Object.entries(files)) {
      if (rel.includes('..')) continue;
      const p = HISTORY_DIR + '/' + rel;
      mkdirp(M.FS, p.slice(0, p.lastIndexOf('/')));
      M.FS.writeFile(p, bytes);
    }
  } catch (err) {
    remember('history not restored: ' + (err && err.message));
  }
}

async function clearHistory() {
  if (phx) rmrf(phx.FS, HISTORY_DIR);
  if (phx) mkdirp(phx.FS, HISTORY_DIR);
  const db = await openDb();
  await store(db, 'readwrite', (s) => s.clear());
  db.close();
}

async function loadPhx() {
  if (phx) return phx;
  const M = await createPhx({ print: remember, printErr: remember });
  M.clearReadAhead = addReadAhead(M);
  mkdirp(M.FS, HISTORY_DIR);
  await restoreHistory(M);
  phx = M;
  return M;
}

async function loadUnrar() {
  if (unrar) return unrar;
  const { default: createUnrar } = await import('./unrar.js');
  const M = await createUnrar({ print: remember, printErr: remember });
  M.clearReadAhead = addReadAhead(M);
  unrar = M;
  return M;
}

async function runPhx(msg) {
  const M = await loadPhx();
  const copied = prepare(M, msg.inputs || [], !!msg.writable);
  const t0 = performance.now();
  let text;
  try {
    const p = M.stringToNewUTF8(JSON.stringify({ v: 1, request: msg.request }));
    const o = M._phx_dispatch(p);
    text = M.UTF8ToString(o);
    M._phx_free(o);
    M._free(p);
  } catch (err) {
    phx = null; // a trap can leave the module unusable; the next job starts a fresh one
    throw new Error('The engine stopped unexpectedly (' + ((err && err.message) || err) + '). It has been restarted — try again.');
  }
  const ms = performance.now() - t0;
  const envelope = JSON.parse(text);
  const out = collect(M, copied);
  release(M);
  await saveHistory(M);
  return { envelope, ms, ...out };
}

async function runRar(msg) {
  const M = await loadUnrar();
  prepare(M, msg.inputs || [], false);
  const t0 = performance.now();
  const args = [msg.mode, '/in/' + msg.archive, '/out', msg.password || '', (msg.selected || []).join('\n')]
    .map((s) => M.stringToNewUTF8(s));
  let text;
  try {
    text = M.UTF8ToString(M._rar_run(...args));
  } catch (err) {
    unrar = null;
    throw new Error('UnRAR stopped unexpectedly (' + ((err && err.message) || err) + '). It has been restarted — try again.');
  } finally {
    if (unrar) args.forEach((p) => M._free(p));
  }
  const ms = performance.now() - t0;
  const result = JSON.parse(text);
  const out = collect(M, new Set());
  release(M);
  return { envelope: { v: 1, response: { result: 'rar', ...result } }, ms, ...out };
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      const t0 = performance.now();
      await loadPhx();
      self.postMessage({ type: 'ready', id: msg.id, ms: performance.now() - t0 });
    } else if (msg.type === 'run') {
      const r = msg.engine === 'rar' ? await runRar(msg) : await runPhx(msg);
      const { transfer, ...rest } = r;
      self.postMessage({ type: 'done', id: msg.id, ...rest }, transfer);
    } else if (msg.type === 'history-clear') {
      await clearHistory();
      self.postMessage({ type: 'done', id: msg.id, envelope: { v: 1, response: { result: 'history_cleared' } }, files: [], ms: 0 });
    } else if (msg.type === 'log') {
      self.postMessage({ type: 'done', id: msg.id, log: quietLog.slice() });
    }
  } catch (err) {
    self.postMessage({ type: 'failed', id: msg.id, message: String((err && err.message) || err) });
  }
};
