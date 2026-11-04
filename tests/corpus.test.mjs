// The data layer, on the parquet fixture (scripts/make_fixture.py; invented texts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Corpus, readParquet, splitName, CHECK, SUBSETS } from "../site/js/corpus.js";

const dir = new URL("./fixtures/", import.meta.url);
const buf = (f) => { const b = readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8"));
const FILES = { dev: "dev-00000-of-00001.parquet", test: "test-00000-of-00001.parquet" };
const corpus = () => Corpus.fromParquet([{ split: "dev", buffer: buf(FILES.dev) }, { split: "test", buffer: buf(FILES.test) }]);

test("readParquet gives the rows exactly as pyarrow reads them, labels as numbers", async () => {
  for (const [split, f] of Object.entries(FILES)) {
    const rows = await readParquet(buf(f));
    assert.deepEqual(rows, expected[split], split);
    assert.equal(typeof rows[0].label, "number");                     // not a BigInt
  }
});

test("readParquet refuses files that are not LLM-AggreFact", async () => {
  await assert.rejects(readParquet(new TextEncoder().encode("hello").buffer), /not a parquet file/);
});

test("splitName reads the split out of a file name", () => {
  assert.equal(splitName("test-00000-of-00001.parquet"), "test");
  assert.equal(splitName("C:\\Downloads\\dev-00000-of-00001 (1).parquet"), "dev");
  assert.equal(splitName("My File.parquet"), "my_file");
});

test("index: aligned columns, subsets in the benchmark's order, ids per split and row", async () => {
  const c = await corpus(), ix = c.index();
  assert.equal(ix.n, 20);
  for (const [name, col] of Object.entries(ix.cols)) assert.equal(col.length, 20, name);
  assert.deepEqual(ix.facets.splits, ["dev", "test"]);
  assert.deepEqual(ix.facets.subsets, SUBSETS.filter((s) => ix.facets.subsets.includes(s)));
  assert.equal(c.id(0), "dev-0");
  assert.equal(c.id(13), "test-0");
  assert.equal(c.claims[c.rowOf.get("test-3")], "抹茶 means rubbed tea.");
  assert.deepEqual(structuredClone(ix), ix);                       // survives postMessage
});

test("documents are stored once and each knows its claims", async () => {
  const c = await corpus();
  assert.equal(c.docs.length, 10);                                  // 20 rows, 10 distinct documents (one blank)
  const bakery = c.doc[c.rowOf.get("dev-4")];
  const ids = Array.from(c.docRows.subarray(c.docOff[bakery], c.docOff[bakery + 1]), (r) => c.id(r));
  assert.deepEqual(ids, ["dev-4", "dev-5", "dev-6", "test-2"]);
});

test("overlap and missing numbers follow the wording", async () => {
  const c = await corpus(), at = (id) => c.rowOf.get(id);
  assert.equal(c.overlap[at("dev-0")], 1);                          // every word is in the document
  assert.equal(c.missingNums[at("dev-1")], 1);                      // 1997 is not; 1987 is
  assert.ok(c.overlap[at("dev-1")] < 1);
  assert.equal(c.missingNums[at("test-6")], 1);                     // 4.2 million vs 2.4 million
  assert.equal(c.overlap[at("dev-12")], 0);                         // nothing is in a blank document
});

test("checks: duplicates, label conflicts, documents in both splits, blank documents", async () => {
  const c = await corpus(), chk = (id) => c.chk[c.rowOf.get(id)];
  assert.equal(chk("dev-9") & (CHECK.dup | CHECK.conflict), CHECK.dup | CHECK.conflict);
  assert.equal(chk("dev-10") & CHECK.conflict, CHECK.conflict);
  assert.ok(chk("dev-4") & CHECK.crossSplit);                       // the bakery Q&A is in dev and test
  assert.ok(chk("test-2") & CHECK.crossSplit);
  assert.ok(chk("dev-12") & CHECK.emptyDoc);
  assert.equal(chk("dev-7"), 0);
  assert.equal(chk("test-0"), 0);
  assert.equal([...c.chk].filter((v) => v & CHECK.crossSplit).length, 4);
});

test("detail: the claim, its document, the best sentence, matched words and the document's other claims", async () => {
  const c = await corpus(), d = c.detail("dev-7");
  assert.equal(d.subset, "Wice");
  assert.equal(d.label, 1);
  const best = d.sentences.reduce((a, b) => (b.hits > a.hits ? b : a));
  assert.equal(d.doc.slice(best.start, best.end), "Its orbit takes roughly 240 years.");
  assert.ok(d.words.some((w) => d.doc.slice(w.start, w.end) === "240"));
  assert.deepEqual(d.mates.map((m) => m.id), ["dev-7", "dev-8"]);
  assert.deepEqual(c.detail("dev-1").missingNumbers, ["1997"]);
  assert.throws(() => c.detail("dev-99"), /no claim/);
});

test("record: the row as the file has it", async () => {
  const c = await corpus();
  assert.deepEqual(c.record("test-3"), expected.test[3]);
  assert.deepEqual(Object.keys(c.record("dev-0")), Object.keys(expected.dev[0]));
});

test("search: scopes, all terms required, phrases whole, case ignored", async () => {
  const c = await corpus(), ids = (rows) => rows.map((r) => c.id(r));
  assert.deepEqual(ids(c.search("SOURDOUGH", "claim")), ["dev-6"]);
  assert.deepEqual(ids(c.search("sourdough", "doc")), ["dev-4", "dev-5", "dev-6", "test-2"]);
  assert.deepEqual(ids(c.search('"seven votes" councillor', "doc")), ["dev-0", "dev-1", "dev-2", "dev-3"]);
  assert.deepEqual(ids(c.search("opposed harbour", "both")), ["dev-3"]);   // one term in the claim, one in the document
  assert.deepEqual(ids(c.search("opposed harbour", "claim")), []);
  assert.deepEqual(c.search("   "), []);
  assert.throws(() => c.search("x", "everywhere"), /unknown scope/);
});

test("a split given twice is refused", () => {
  assert.throws(() => new Corpus([{ split: "dev", rows: [] }, { split: "dev", rows: [] }]), /two files for the same split/);
});
