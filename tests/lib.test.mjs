// The pure helpers.
import test from "node:test";
import assert from "node:assert/strict";
import {
  wordSpans, wordCount, stem, contentStems, numbers, docProfile, overlap, sentences, rankSentences, matchedWords,
  segment, terms, termPatterns, wilson, auroc, quantile, median, quantileEdges, binOf, niceTicks, jsonTokens, fmtPct, fmtBytes,
} from "../site/js/lib.js";

test("words: letters and digits in any script, apostrophes kept inside", () => {
  assert.deepEqual(wordSpans("Rosa's café, 抹茶!").map((w) => w.w), ["Rosa's", "café", "抹茶"]);
  assert.equal(wordCount("  two  words "), 2);
  assert.equal(wordCount(""), 0);
});

test("stem: inflections meet, numbers lose their thousands separators", () => {
  for (const [a, b] of [["repairs", "repaired"], ["repairing", "repair"], ["cities", "city"], ["boxes", "box"]]) assert.equal(stem(a), stem(b), `${a}/${b}`);
  assert.equal(stem("bus"), "bus");
  assert.equal(stem("2,400"), "2400");
  assert.equal(stem("Vidal's"), "vidal");
});

test("contentStems drops stop words; numbers() keeps decimals whole", () => {
  assert.deepEqual([...contentStems("The wall was built in 1931")], ["wall", "built", "1931"]);
  assert.deepEqual(numbers("2.4 million, not 4.2; 1,500 people in 1931."), ["2.4", "4.2", "1500", "1931"]);
});

test("overlap: share of the claim's content words in the document, and numbers it lacks", () => {
  const p = docProfile("Engineers said the wall was built in 1931 and repaired in 1987.");
  assert.deepEqual(overlap("The wall was repaired in 1987.", p), { share: 1, missingNumbers: 0 });
  const o = overlap("The wall was repaired in 1997.", p);
  assert.equal(o.missingNumbers, 1);
  assert.ok(o.share > 0.5 && o.share < 1);
  assert.ok(Number.isNaN(overlap("It was.", p).share));
});

test("sentences: split after terminal punctuation and at line breaks, offsets exact", () => {
  const t = "Dr. Vidal saw it. It was faint!\n\nQ: When?  A: In 1931.";
  const s = sentences(t).map(({ start, end }) => t.slice(start, end));
  assert.deepEqual(s, ["Dr. Vidal saw it.", "It was faint!", "Q: When?", "A: In 1931."]);
  assert.deepEqual(sentences("   "), []);
});

test("rankSentences and matchedWords point at the supporting sentence", () => {
  const doc = "The council met on Tuesday. The wall was built in 1931. Work begins in spring.";
  const ranked = rankSentences(doc, "The harbour wall was built in 1931.");
  const best = ranked.reduce((a, b) => (b.hits > a.hits ? b : a));
  assert.equal(doc.slice(best.start, best.end), "The wall was built in 1931.");
  const words = matchedWords(doc, best.start, best.end, contentStems("walls built 1931"));
  assert.deepEqual(words.map(({ start, end }) => doc.slice(start, end)), ["wall", "built", "1931"]);
});

test("segment covers the text and records overlaps", () => {
  const seg = segment(10, [{ start: 2, end: 6 }, { start: 4, end: 8 }]);
  assert.deepEqual(seg.map((s) => [s.start, s.end, s.ids]), [[0, 2, []], [2, 4, [0]], [4, 6, [0, 1]], [6, 8, [1]], [8, 10, []]]);
});

test("search terms: words and quoted phrases; phrases match across whitespace", () => {
  assert.deepEqual(terms('Harbour "seven  votes" '), ["harbour", "seven  votes"]);
  const [re] = termPatterns('"seven votes"');
  assert.ok(re.test("by Seven\nvotes"));
  assert.deepEqual(termPatterns("  "), []);
  assert.ok(termPatterns("a.b")[0].test("A.B") && !termPatterns("a.b")[0].test("axb"));
});

test("auroc: perfect, reversed, chance, ties and NaN", () => {
  assert.equal(auroc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auroc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(auroc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  assert.equal(auroc([NaN, 0.1, 0.9], [1, 0, 1]), 1);
  assert.ok(Number.isNaN(auroc([0.1, 0.2], [1, 1])));
});

test("wilson, quantiles, bins and ticks", () => {
  const [lo, hi] = wilson(5, 10);
  assert.ok(lo < 0.5 && hi > 0.5);
  assert.deepEqual(wilson(0, 0), [0, 0]);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  assert.ok(Number.isNaN(median([])));
  const e = quantileEdges([1, 1, 1, 2, 3, 4], 3);
  assert.deepEqual(e, [1, 2, 4]);
  assert.equal(binOf(e, 4), 1);
  assert.deepEqual(niceTicks(9).ticks.at(-1) >= 9, true);
});

test("jsonTokens round-trips; formatters", () => {
  const t = JSON.stringify({ a: "x", b: [1, true, null] }, null, 2);
  assert.equal(jsonTokens(t).map((p) => p.text).join(""), t);
  assert.equal(fmtPct(NaN), "–");
  assert.equal(fmtBytes(17298205), "17.3 MB");
});
