// The page's side of the data: the index (typed arrays and the claims), the
// global filters every view reads, the URL round-trip, and calls to the worker.

export const D = { ready: false };

/** Data checks by URL name -> bit (see CHECK in corpus.js). */
export const CHECKS = [
  { key: "dup", bit: 1, label: "Duplicate claim", tip: "The same claim about the same document appears more than once" },
  { key: "conflict", bit: 2, label: "Conflicting labels", tip: "Copies of the same claim about the same document carry different labels" },
  { key: "both-splits", bit: 4, label: "Document in both splits", tip: "The document also appears, with other claims, in the other split" },
  { key: "blank-doc", bit: 8, label: "Blank document", tip: "The document is empty" },
];

/** Filters are one shared object: the overview and the browser look through the same window. */
export const F = {
  subset: new Set(), split: new Set(),
  label: "any",          // any | supported | unsupported
  checks: new Set(),     // bits; a row passes if it has any of them
  num: false,            // only claims with a number their document lacks
  q: "", scope: "both",
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = () => listeners.forEach((fn) => fn());

// ------------------------------------------------------------ the worker

let worker = null, nextCall = 0, onProgress = () => {};
const pending = new Map();

function startWorker() {
  worker = new Worker(new URL("./corpus.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.progress) return onProgress(data.progress);
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    if (data.error) call.reject(new Error(data.error)); else call.resolve(data.result);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    const err = new Error(e.message || "the data worker failed to start");
    pending.forEach((call) => call.reject(err));
    pending.clear();
  };
}

function ask(op, args, transfer = []) {
  if (!worker) startWorker();
  return new Promise((resolve, reject) => {
    const id = ++nextCall;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer);
  });
}

/**
 * Load the benchmark in the worker. args: {from: "auto"|"files"|"hf", prefer?, files?: [{name, buffer}], token?}
 * -> {needData: true} when nothing is available yet, else the source description (and D is ready).
 */
export async function loadData(args, progress) {
  if (progress) onProgress = progress;
  const transfer = (args.files || []).map((f) => f.buffer);
  const res = await ask("load", args, transfer);
  if (res.needData) return res;
  install(res.index);
  D.source = res.source;
  return res.source;
}

export const forgetData = () => ask("forget");

function install(ix) {
  const c = ix.cols;
  Object.assign(D, {
    n: ix.n, f: ix.facets, nDocs: ix.docs.n, docWords: ix.docs.words, claims: ix.claims,
    split: c.split, idx: c.idx, subset: c.subset, label: c.label, doc: c.doc,
    cw: c.cw, ov: c.ov, nm: c.nm, chk: c.chk,
  });
  D.id = (i) => `${D.f.splits[D.split[i]]}-${D.idx[i]}`;
  D.ids = Array.from({ length: D.n }, (_, i) => D.id(i));
  D.rowOfId = new Map(D.ids.map((id, i) => [id, i]));
  D.dw = Int32Array.from(D.doc, (d) => D.docWords[d]);
  // Rows of each document (CSR, file order).
  D.docOff = new Int32Array(D.nDocs + 1);
  for (const d of D.doc) D.docOff[d + 1]++;
  for (let d = 0; d < D.nDocs; d++) D.docOff[d + 1] += D.docOff[d];
  D.docRows = new Int32Array(D.n);
  const fill = D.docOff.slice(0, D.nDocs);
  for (let i = 0; i < D.n; i++) D.docRows[fill[D.doc[i]]++] = i;
  D.docN = Int32Array.from({ length: D.nDocs }, (_, d) => D.docOff[d + 1] - D.docOff[d]);
  D.searchMask = null;
  D.ready = true;
}

// ------------------------------------------------------------ filtering

/** Rows passing every filter, in file order. */
export function select() {
  const sub = F.subset.size ? F.subset : null, spl = F.split.size ? F.split : null;
  const chkBits = [...F.checks].reduce((b, x) => b | x, 0);
  const want = F.label === "supported" ? 1 : F.label === "unsupported" ? 0 : -1;
  const out = [];
  for (let i = 0; i < D.n; i++) {
    if (sub && !sub.has(D.subset[i])) continue;
    if (spl && !spl.has(D.split[i])) continue;
    if (want >= 0 && D.label[i] !== want) continue;
    if (chkBits && !(D.chk[i] & chkBits)) continue;
    if (F.num && !D.nm[i]) continue;
    if (F.q && !(D.searchMask && D.searchMask[i])) continue;
    out.push(i);
  }
  return Int32Array.from(out);
}

export function activeFilterCount() {
  return F.subset.size + F.split.size + F.checks.size + (F.label !== "any") + (F.num ? 1 : 0) + (F.q ? 1 : 0);
}

export function resetFilters() {
  F.subset.clear(); F.split.clear(); F.checks.clear();
  F.label = "any"; F.num = false; F.q = ""; F.scope = "both";
  D.searchMask = null;
}

let searchSeq = 0;
/** Apply a text query (run in the worker); filters update once the answer is in. */
export async function applyQuery(q, scope) {
  const mine = ++searchSeq;
  q = q.trim();
  if (!q) {
    F.q = ""; F.scope = scope; D.searchMask = null;
    return emit();
  }
  const rows = await ask("search", { q, scope });
  if (mine !== searchSeq) return;                       // a newer keystroke overtook this one
  const mask = new Uint8Array(D.n);
  for (const r of rows) mask[r] = 1;
  F.q = q; F.scope = scope; D.searchMask = mask;
  emit();
}

// ------------------------------------------------------------ URL <-> filters

export function filtersToParams() {
  const p = new URLSearchParams();
  if (F.subset.size) p.set("subset", [...F.subset].sort((a, b) => a - b).map((k) => D.f.subsets[k]).join("|"));
  if (F.split.size) p.set("split", [...F.split].sort((a, b) => a - b).map((k) => D.f.splits[k]).join("|"));
  if (F.label !== "any") p.set("label", F.label);
  if (F.checks.size) p.set("check", CHECKS.filter((c) => F.checks.has(c.bit)).map((c) => c.key).join("|"));
  if (F.num) p.set("num", "1");
  if (F.q) { p.set("q", F.q); p.set("in", F.scope); }
  return p;
}

/** Returns the search to apply afterwards, if the URL carried one. */
export function paramsToFilters(p) {
  const codes = (key, names) => new Set((p.get(key) || "").split("|").map((nm) => names.indexOf(nm)).filter((k) => k >= 0));
  F.subset = codes("subset", D.f.subsets);
  F.split = codes("split", D.f.splits);
  F.label = ["supported", "unsupported"].includes(p.get("label")) ? p.get("label") : "any";
  const keys = (p.get("check") || "").split("|");
  F.checks = new Set(CHECKS.filter((c) => keys.includes(c.key)).map((c) => c.bit));
  F.num = p.get("num") === "1";
  return { q: p.get("q") || "", scope: ["claim", "doc", "both"].includes(p.get("in")) ? p.get("in") : "both" };
}

// ------------------------------------------------------------ records

const cache = new Map();
function cached(key, load) {
  if (cache.has(key)) return cache.get(key);
  const p = load().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, p);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return p;
}
/** One claim with its document, ranked sentences and the document's other claims. */
export const getDetail = (id) => cached(`d/${id}`, () => ask("detail", { id }));
/** The row exactly as the file has it. */
export const getRecord = (id) => cached(`r/${id}`, () => ask("record", { id }));

/** Row facts for a list entry, no worker needed. */
export function rowInfo(i) {
  return {
    id: D.ids[i], row: i, subset: D.f.subsets[D.subset[i]], split: D.f.splits[D.split[i]],
    label: D.label[i], claim: D.claims[i], docWords: D.dw[i], claimsOnDoc: D.docN[D.doc[i]],
    overlap: D.ov[i], missingNumbers: D.nm[i], checks: D.chk[i],
  };
}
