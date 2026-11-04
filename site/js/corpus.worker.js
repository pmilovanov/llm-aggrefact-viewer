// The benchmark lives here, off the main thread: reading ~50 MB of parquet never
// freezes the page. The page asks once for the index, then for single claims
// and searches.
//
// Protocol: {id, op, args} in; {id, result} or {id, error} out, plus
// {progress} messages while loading.
//
// Where the files come from, in order:
//   stored  this browser's copy from an earlier visit (IndexedDB)
//   local   site/data/ (`just fetch-data`), tried when served from this machine or with ?data=local
//   files   files the visitor chose or dropped on the page
//   hf      Hugging Face, with the visitor's access token (sent there and nowhere else, not kept)

import { Corpus, splitName } from "./corpus.js";
import { FILES, SIZES, fileUrl } from "./config.js";
import * as store from "./store.js";

const LOCAL_BASE = new URL("../data/", import.meta.url).href;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SPLIT_ORDER = ["dev", "validation", "test", "train"];

let corpus = null;
const progress = (p) => self.postMessage({ progress: p });

async function fetchBytes(url, init, onBytes) {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const why = resp.headers.get("x-error-message");
    const err = new Error(why || `${url.split("?")[0]}: HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  if (!resp.body) { const b = await resp.arrayBuffer(); onBytes(b.byteLength); return b; }
  const reader = resp.body.getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
    onBytes(value.byteLength);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return all.buffer;
}

/** Both pinned files from one place, reporting progress against their known size. */
async function download(where, urlOf, init) {
  const names = [FILES.dev, FILES.test];
  const total = names.reduce((n, f) => n + SIZES[f], 0);
  let loaded = 0, shown = -1;
  const onBytes = (n) => {
    loaded += n;
    const pct = Math.floor((100 * loaded) / total);
    if (pct !== shown) { shown = pct; progress({ stage: "download", where, loaded, total }); }
  };
  const buffers = await Promise.all(names.map((f) => fetchBytes(urlOf(f), init, onBytes)));
  return names.map((name, k) => ({ name, split: splitName(name), buffer: buffers[k] }));
}

const order = (files) => files.slice().sort((a, b) =>
  (SPLIT_ORDER.indexOf(a.split) + 1 || 99) - (SPLIT_ORDER.indexOf(b.split) + 1 || 99) || a.split.localeCompare(b.split));

async function build(files, from) {
  progress({ stage: "parse" });
  corpus = await Corpus.fromParquet(order(files), (split) => progress({ stage: "parse", split }));
  let saved = from === "stored";
  if (from === "files" || from === "hf") {
    try { await store.save(files); saved = true; } catch { /* private window or no quota: works, just not remembered */ }
  }
  return {
    index: corpus.index(),
    source: { from, saved, files: order(files).map((f) => ({ name: f.name, split: f.split, size: f.buffer.byteLength, pinned: SIZES[f.name] === f.buffer.byteLength })) },
  };
}

async function load({ from = "auto", prefer, files, token } = {}) {
  if (from === "auto") {
    const stored = await store.load();
    if (stored.length) {
      try { return await build(stored, "stored"); }
      catch { await store.clear().catch(() => {}); }          // unreadable: forget it, ask again
    }
    const tryLocal = prefer === "local" || (prefer !== "none" && LOCAL_HOSTS.includes(self.location.hostname));
    if (tryLocal) {
      try { return await build(await download("local", (f) => LOCAL_BASE + f), "local"); }
      catch { /* no local copy */ }
    }
    return { needData: true };
  }
  if (from === "files") {
    if (!files?.length) throw new Error("no files given");
    const named = files.map((f) => ({ name: f.name, split: splitName(f.name), buffer: f.buffer }));
    const seen = new Set();
    for (const f of named) {
      if (seen.has(f.split)) throw new Error(`two files for the ${f.split} split: choose one of each`);
      seen.add(f.split);
    }
    return build(named, "files");
  }
  if (from === "hf") {
    const t = String(token || "").trim();
    if (!t) throw new Error("no access token given");
    try {
      return await build(await download("hf", fileUrl, { headers: { Authorization: `Bearer ${t}` }, credentials: "omit" }), "hf");
    } catch (e) {
      if (e.status === 401) throw new Error("Hugging Face refused the token (401). Check that it is valid and that it may read gated repositories.");
      if (e.status === 403) throw new Error("Hugging Face says this account has no access yet (403). Accept the dataset's terms on its page first.");
      throw e;
    }
  }
  throw new Error(`unknown source ${from}`);
}

self.onmessage = async ({ data: { id, op, args = {} } }) => {
  try {
    let result;
    if (op === "load") result = await load(args);
    else if (op === "forget") { await store.clear(); result = true; }
    else if (!corpus) throw new Error("the benchmark is not loaded yet");
    else if (op === "detail") result = corpus.detail(args.id);
    else if (op === "record") result = corpus.record(args.id);
    else if (op === "search") result = corpus.search(args.q, args.scope);
    else throw new Error(`unknown operation ${op}`);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
