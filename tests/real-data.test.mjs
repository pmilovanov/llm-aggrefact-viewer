// Checks against the real benchmark. They run when site/data/ holds it
// (`just fetch-data`; CI fetches it when the repository has an HF_TOKEN secret)
// and are skipped otherwise.
//
// These tests must never print the benchmark's text: CI logs are public, and the
// dataset's terms forbid putting it where web crawlers can read it. So they
// compare counts and digests, never strings from the data, and every assertion
// that could fail on text uses assert.ok with a message of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Corpus, readParquet, CHECK, SUBSETS } from "../site/js/corpus.js";
import { FILES, SIZES } from "../site/js/config.js";

const dir = new URL("../site/data/", import.meta.url);
const present = Object.values(FILES).every((f) => existsSync(new URL(f, dir)));
const skip = present ? false : "the benchmark is not in site/data/ (run `just fetch-data`)";
const buf = (f) => { const b = readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

let rowsCache = null, corpusCache = null;
const rows = async () => (rowsCache ||= { dev: await readParquet(buf(FILES.dev)), test: await readParquet(buf(FILES.test)) });
const corpus = async () => (corpusCache ||= new Corpus([{ split: "dev", rows: (await rows()).dev }, { split: "test", rows: (await rows()).test }]));

test("the files are the pinned ones", { skip }, () => {
  for (const f of Object.values(FILES)) assert.equal(statSync(new URL(f, dir)).size, SIZES[f], f);
});

test("the reader returns every row exactly as pyarrow does (digest from scripts/digest.py)", { skip }, async () => {
  const r = await rows();
  assert.equal(r.dev.length, 30420);
  assert.equal(r.test.length, 29320);
  const total = createHash("sha256");
  for (const split of ["dev", "test"]) {
    for (const x of r[split]) {
      const row = [x.dataset, x.doc, x.claim, String(x.label), x.contamination_identifier].join("\u0000");
      total.update(createHash("sha1").update(row).digest("hex") + "\n");
    }
  }
  const want = readFileSync(new URL("./real-data.digest", import.meta.url), "utf8").trim();
  assert.ok(total.digest("hex") === want, "rows differ from pyarrow's reading (digest mismatch)");
});

test("subset sizes and label balance match pyarrow's count", { skip }, async () => {
  // [claims, supported] per split, counted with pyarrow from the pinned files.
  const want = {
    "AggreFact-CNN": [[459, 400], [558, 501]], "AggreFact-XSum": [[777, 394], [558, 285]],
    "TofuEval-MediaS": [[1800, 1446], [726, 554]], "TofuEval-MeetB": [[1607, 1318], [772, 622]],
    Wice: [[349, 115], [358, 111]], Reveal: [[1656, 385], [1710, 400]], ClaimVerify: [[1093, 821], [1088, 789]],
    "FactCheck-GPT": [[1537, 266], [1566, 376]], ExpertQA: [[3773, 2941], [3702, 2971]],
    Lfqa: [[2029, 1150], [1911, 1121]], RAGTruth: [[15340, 13782], [16371, 15102]],
  };
  const r = await rows();
  const got = {};
  ["dev", "test"].forEach((split, s) => {
    for (const x of r[split]) {
      const g = (got[x.dataset] ||= [[0, 0], [0, 0]]);
      g[s][0]++; g[s][1] += x.label;
    }
  });
  assert.deepEqual(Object.keys(got).sort(), [...SUBSETS].sort());
  assert.deepEqual(got, want);
});

test("documents and data checks match an independent count with pyarrow", { skip }, async () => {
  const c = await corpus();
  const count = (bit) => c.chk.reduce((n, v) => n + (v & bit ? 1 : 0), 0);
  assert.equal(c.docs.length, 18779);
  assert.equal(count(CHECK.dup), 519);
  assert.equal(count(CHECK.conflict), 31);
  assert.equal(count(CHECK.crossSplit), 762);
  assert.equal(count(CHECK.emptyDoc), 0);
});

test("every id is unique and every detail is well-formed", { skip }, async () => {
  const c = await corpus();
  assert.equal(c.rowOf.size, c.n);
  for (let r = 0; r < c.n; r += 97) {                     // a spread sample; all of them takes minutes
    const d = c.detail(c.id(r));
    assert.ok(d.mates.some((m) => m.id === d.id), `row ${r}: not among its document's claims`);
    for (const s of d.sentences) assert.ok(s.start >= 0 && s.start < s.end && s.end <= d.doc.length, `row ${r}: sentence out of range`);
    for (const w of d.words) assert.ok(w.start >= 0 && w.start < w.end && w.end <= d.doc.length, `row ${r}: word out of range`);
  }
});
