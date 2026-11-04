// The data layer. Rows from the benchmark's parquet files become a compact
// columnar index (posted to the page, which does all aggregation) while the
// texts stay here, in the worker, for detail views and search. No DOM.

import { parquetMetadata, parquetReadObjects } from "../vendor/hyparquet/index.js";
import { docProfile, overlap, wordCount, termPatterns, rankSentences, matchedWords, contentStems, numbers } from "./lib.js";

/** The eleven subsets in the benchmark's own order; any other name is kept and put last. */
export const SUBSETS = [
  "AggreFact-CNN", "AggreFact-XSum", "TofuEval-MediaS", "TofuEval-MeetB", "Wice", "Reveal",
  "ClaimVerify", "FactCheck-GPT", "ExpertQA", "Lfqa", "RAGTruth",
];
/** The columns of a row, in the files' order. */
export const COLUMNS = ["dataset", "doc", "claim", "label", "contamination_identifier"];
const REQUIRED = ["dataset", "doc", "claim", "label"];

/** Data checks, as bits of the index's `chk` column. */
export const CHECK = {
  dup: 1,          // the same claim about the same document appears more than once
  conflict: 2,     // ... and its copies disagree on the label
  crossSplit: 4,   // the document also appears in another split
  emptyDoc: 8,     // the document is blank
};
export const SEARCH_SCOPES = ["claim", "doc", "both"];

/** "dev"/"test" from a file name like test-00000-of-00001.parquet, else a URL-safe name. */
export function splitName(fileName) {
  const base = String(fileName).split(/[\\/]/).pop().replace(/\.parquet$/i, "").toLowerCase();
  const m = /(?:^|[^a-z])(dev|test|train|validation)(?:[^a-z]|$)/.exec(base);
  return m ? m[1] : base.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "data";
}

/**
 * The rows of one parquet file, labels as numbers (int64 arrives as BigInt).
 * Throws a readable error when the file is not shaped like LLM-AggreFact.
 */
export async function readParquet(buffer) {
  let metadata;
  try { metadata = parquetMetadata(buffer); }
  catch (e) { throw new Error(`not a parquet file (${e.message})`); }
  const names = metadata.schema.slice(1).map((s) => s.name);
  const missing = REQUIRED.filter((c) => !names.includes(c));
  if (missing.length) throw new Error(`not LLM-AggreFact: no ${missing.join(", ")} column`);
  const rows = await parquetReadObjects({ file: buffer, metadata, columns: COLUMNS.filter((c) => names.includes(c)) });
  for (const r of rows) {
    const l = Number(r.label);
    if (l !== 0 && l !== 1) throw new Error(`not LLM-AggreFact: label ${String(r.label)} is neither 0 nor 1`);
    r.label = l;
  }
  return rows;
}

const ordered = (seen, preferred) =>
  [...preferred.filter((x) => seen.has(x)), ...[...seen].filter((x) => !preferred.includes(x)).sort()];

export class Corpus {
  /** files: [{split, buffer}] -> Corpus, splits in the order given. */
  static async fromParquet(files, onFile = () => {}) {
    const parts = [];
    for (const f of files) {
      onFile(f.split);
      parts.push({ split: f.split, rows: await readParquet(f.buffer) });
    }
    return new Corpus(parts);
  }

  /** parts: [{split, rows: [{dataset, doc, claim, label, contamination_identifier?}]}] */
  constructor(parts) {
    const splits = parts.map((p) => p.split);
    if (new Set(splits).size !== splits.length) throw new Error(`two files for the same split (${splits.join(", ")})`);
    const seen = new Set();
    for (const p of parts) for (const r of p.rows) seen.add(r.dataset);
    this.splits = splits;
    this.subsets = ordered(seen, SUBSETS);
    const subsetCode = new Map(this.subsets.map((s, k) => [s, k]));

    const n = parts.reduce((a, p) => a + p.rows.length, 0);
    this.n = n;
    this.split = new Uint8Array(n);
    this.idx = new Int32Array(n);
    this.subset = new Uint8Array(n);
    this.label = new Uint8Array(n);
    this.doc = new Int32Array(n);
    this.claims = new Array(n);
    this.cids = new Array(n);
    this.docs = [];                       // unique document texts
    this.rowOf = new Map();               // "test-12" -> row
    const docId = new Map();

    let i = 0;
    parts.forEach((p, s) => {
      p.rows.forEach((r, k) => {
        let d = docId.get(r.doc);
        if (d === undefined) { d = this.docs.length; docId.set(r.doc, d); this.docs.push(r.doc); }
        this.split[i] = s;
        this.idx[i] = k;
        this.subset[i] = subsetCode.get(r.dataset);
        this.label[i] = r.label;
        this.doc[i] = d;
        this.claims[i] = r.claim;
        this.cids[i] = r.contamination_identifier ?? null;
        this.rowOf.set(`${p.split}-${k}`, i);
        i++;
      });
    });

    // Rows of each document (CSR): docRows[docOff[d] .. docOff[d+1])
    const nd = this.docs.length;
    this.docOff = new Int32Array(nd + 1);
    for (let r = 0; r < n; r++) this.docOff[this.doc[r] + 1]++;
    for (let d = 0; d < nd; d++) this.docOff[d + 1] += this.docOff[d];
    this.docRows = new Int32Array(n);
    const fill = this.docOff.slice(0, nd);
    for (let r = 0; r < n; r++) this.docRows[fill[this.doc[r]]++] = r;

    this.#measure();
    this.#check();
  }

  id(row) { return `${this.splits[this.split[row]]}-${this.idx[row]}`; }

  /** Word counts, and how much of each claim's wording its document contains (one document at a time, to keep memory flat). */
  #measure() {
    const { n, docs } = this;
    this.docWords = new Int32Array(docs.length);
    this.claimWords = new Uint16Array(n);
    this.overlap = new Float32Array(n);
    this.missingNums = new Uint8Array(n);
    for (let d = 0; d < docs.length; d++) {
      const profile = docProfile(docs[d]);
      this.docWords[d] = profile.words;
      for (let k = this.docOff[d]; k < this.docOff[d + 1]; k++) {
        const r = this.docRows[k];
        const o = overlap(this.claims[r], profile);
        this.claimWords[r] = Math.min(65535, wordCount(this.claims[r]));
        this.overlap[r] = o.share;
        this.missingNums[r] = Math.min(255, o.missingNumbers);
      }
    }
  }

  /** Duplicates, label conflicts, documents shared between splits, blank documents. */
  #check() {
    const { n, docs } = this;
    this.chk = new Uint8Array(n);
    const groups = new Map();                              // doc + claim -> rows
    for (let r = 0; r < n; r++) {
      const key = `${this.doc[r]}\u0000${this.claims[r]}`;
      (groups.get(key) || groups.set(key, []).get(key)).push(r);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const mixed = rows.some((r) => this.label[r] !== this.label[rows[0]]);
      for (const r of rows) this.chk[r] |= CHECK.dup | (mixed ? CHECK.conflict : 0);
    }
    for (let d = 0; d < docs.length; d++) {
      const blank = !docs[d].trim();
      let splits = 0;
      for (let k = this.docOff[d]; k < this.docOff[d + 1]; k++) splits |= 1 << this.split[this.docRows[k]];
      const shared = splits & (splits - 1);              // more than one bit set
      for (let k = this.docOff[d]; k < this.docOff[d + 1]; k++) {
        const r = this.docRows[k];
        if (shared) this.chk[r] |= CHECK.crossSplit;
        if (blank) this.chk[r] |= CHECK.emptyDoc;
      }
    }
  }

  /** The compact index the page works from (typed arrays; cheap to post between threads). */
  index() {
    return {
      n: this.n,
      facets: { subsets: this.subsets, splits: this.splits },
      cols: {
        split: this.split, idx: this.idx, subset: this.subset, label: this.label, doc: this.doc,
        cw: this.claimWords, ov: this.overlap, nm: this.missingNums, chk: this.chk,
      },
      claims: this.claims,                // short; the list shows them. Documents stay here.
      docs: { n: this.docs.length, words: this.docWords },
    };
  }

  #row(id) {
    const r = this.rowOf.get(String(id));
    if (r === undefined) throw new Error(`no claim ${JSON.stringify(id)}`);
    return r;
  }

  /** One claim with its document: sentences ranked against the claim, matching words, the document's other claims. */
  detail(id) {
    const r = this.#row(id);
    const d = this.doc[r], doc = this.docs[d], claim = this.claims[r];
    const claimStems = contentStems(claim);
    const sents = rankSentences(doc, claim);
    const words = sents.filter((s) => s.hits).flatMap((s) => matchedWords(doc, s.start, s.end, claimStems));
    const docNums = new Set(numbers(doc));
    const mates = [];
    for (let k = this.docOff[d]; k < this.docOff[d + 1]; k++) {
      const m = this.docRows[k];
      mates.push({ id: this.id(m), row: m, subset: this.subsets[this.subset[m]], split: this.splits[this.split[m]], label: this.label[m], claim: this.claims[m] });
    }
    return {
      id: this.id(r), row: r, subset: this.subsets[this.subset[r]], split: this.splits[this.split[r]],
      label: this.label[r], claim, doc, docId: d, docWords: this.docWords[d],
      overlap: this.overlap[r], missingNumbers: numbers(claim).filter((x) => !docNums.has(x)), checks: this.chk[r],
      sentences: sents, words, mates,
    };
  }

  /** The row exactly as the file has it (label as a number, since JSON has no int64). */
  record(id) {
    const r = this.#row(id);
    const out = {
      dataset: this.subsets[this.subset[r]], doc: this.docs[this.doc[r]], claim: this.claims[r], label: this.label[r],
    };
    if (this.cids[r] !== null) out.contamination_identifier = this.cids[r];
    return out;
  }

  /**
   * Rows where every term (case-insensitive; "quoted phrases" whole) occurs in the
   * claim (scope "claim"), the document ("doc"), or either, term by term ("both").
   */
  search(q, scope = "both") {
    if (!SEARCH_SCOPES.includes(scope)) throw new Error(`unknown scope ${scope}`);
    const pats = termPatterns(q);
    if (!pats.length) return [];
    const alive = new Uint8Array(this.n).fill(1), inDoc = new Uint8Array(this.docs.length);
    for (const re of pats) {
      if (scope !== "claim") this.docs.forEach((text, d) => { inDoc[d] = re.test(text) ? 1 : 0; });
      for (let r = 0; r < this.n; r++) {
        if (alive[r]) alive[r] = (scope !== "doc" && re.test(this.claims[r])) || (scope !== "claim" && inDoc[this.doc[r]]) ? 1 : 0;
      }
    }
    const rows = [];
    alive.forEach((v, r) => { if (v) rows.push(r); });
    return rows;
  }
}
