// Pure helpers: no DOM, no fetch. Tested with `node --test` (see ../../tests).

// ------------------------------------------------------------------ words
// A word is a run of letters and digits (any script), with inner apostrophes
// ("Rosa's"). Scanned by hand: a Unicode regex is too slow for the ~8.5 million
// words in the benchmark's documents.

const LETTER = /\p{L}/u, WORDCHAR = /[\p{L}\p{N}]/u;
const uniCache = new Map();
function uni(cp, re) {
  const key = re === LETTER ? -cp - 1 : cp;
  let v = uniCache.get(key);
  if (v === undefined) { v = re.test(String.fromCodePoint(cp)); uniCache.set(key, v); }
  return v;
}
const ascii = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
const isWord = (cp) => ascii(cp) || (cp >= 48 && cp <= 57) || (cp > 127 && uni(cp, WORDCHAR));
const isLetter = (cp) => ascii(cp) || (cp > 127 && uni(cp, LETTER));
const width = (cp) => (cp > 0xffff ? 2 : 1);

/** Call fn(start, end) for every word of text, in order. */
export function scanWords(text, fn) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    let cp = text.codePointAt(i);
    if (!isWord(cp)) { i += width(cp); continue; }
    const start = i;
    while (i < n && isWord(cp = text.codePointAt(i))) i += width(cp);
    // inner apostrophes: Rosa's, don’t
    while (i + 1 < n && (text[i] === "'" || text[i] === "’") && isLetter(text.codePointAt(i + 1))) {
      i++;
      while (i < n && isLetter(cp = text.codePointAt(i))) i += width(cp);
    }
    fn(start, i);
  }
}

/** Words in reading order, with their offsets in `text`. */
export function wordSpans(text) {
  const out = [];
  scanWords(text, (start, end) => out.push({ w: text.slice(start, end), start, end }));
  return out;
}

export function wordCount(text) {
  let n = 0;
  scanWords(text, () => { n++; });
  return n;
}

/** A small English stop list: words that say nothing about whether a claim is supported. */
export const STOP = new Set((
  "a an and are as at be been being but by can could did do does doing for from had has have having he her here hers him his " +
  "how i if in into is it its it's itself just me more most my no nor not of off on once only or other our ours out over own " +
  "same she should so some such than that that's the their theirs them then there these they this those through to too under " +
  "until up very was we were what when where which while who whom why will with would you your yours also about after again " +
  "against all any because before below between both down during each few further s t don now"
).split(" "));

/**
 * A crude stem, enough to let "repairs", "repaired" and "repairing" meet.
 * Numbers are kept whole, with thousands separators removed ("2,400" = "2400").
 */
export function stem(word) {
  let w = word.toLowerCase().replace(/[’']/g, "'");
  if (/^\d[\d,.]*$/.test(w)) return w.replace(/,(?=\d{3}\b)/g, "").replace(/\.$/, "");
  w = w.replace(/'s$/, "");
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ied")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

const stemCache = new Map();
/** stem() of a lower-cased word, remembered: the benchmark has ~150k distinct words and millions of occurrences. */
function stemLower(lw) {
  let s = stemCache.get(lw);
  if (s === undefined) {
    s = stem(lw);
    if (stemCache.size > 400000) stemCache.clear();
    stemCache.set(lw, s);
  }
  return s;
}

/** The distinct content words of a text, stemmed. */
export function contentStems(text) {
  const out = new Set();
  scanWords(text, (a, b) => {
    const lw = text.slice(a, b).toLowerCase();
    if (!STOP.has(lw)) out.add(stemLower(lw));
  });
  return out;
}

/** Numbers as written in a text (digits, optionally with , or . inside), normalised like stem(). */
export function numbers(text) {
  return [...new Set((text.match(/\d[\d,.]*\d|\d/g) || []).map((n) => stem(n)))];
}

/** What overlap() needs to know about a document, in one pass: its content stems, its numbers, its length in words. */
export function docProfile(text) {
  const stems = new Set();
  let words = 0;
  scanWords(text, (a, b) => {
    words++;
    const lw = text.slice(a, b).toLowerCase();
    if (!STOP.has(lw)) stems.add(stemLower(lw));
  });
  return { stems, nums: new Set(numbers(text)), words };
}

/**
 * How much of a claim's wording the document contains.
 * -> {share: content words found / content words (NaN if none), missingNumbers: numbers in the claim absent from the doc}
 */
export function overlap(claim, profile) {
  const c = contentStems(claim);
  let hit = 0;
  for (const s of c) if (profile.stems.has(s)) hit++;
  const missing = numbers(claim).filter((n) => !profile.nums.has(n)).length;
  return { share: c.size ? hit / c.size : NaN, missingNumbers: missing };
}

// -------------------------------------------------------------- sentences

const ABBREV = /(?:^|[^\p{L}])(?:\p{Lu}|Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|Gen|Col|Lt|Sgt|Rev|Hon|No|vs|etc|e\.g|i\.e|cf|approx|Inc|Ltd|Co|Corp|U\.S|U\.K)$/u;

/**
 * Sentence spans [{start, end}] covering the text's non-blank stretches.
 * Splits after . ! ? (and closing quotes) before an upper-case letter, digit or
 * quote, and at line breaks. Abbreviations will fool it now and then; it only
 * guides the eye.
 */
export function sentences(text) {
  const out = [];
  const push = (a, b) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) out.push({ start: a, end: b });
  };
  let from = 0;
  const re = /[.!?…]["'”’)\]]*\s+(?=["'“‘(\[]?[\p{Lu}\p{N}])|\n+/gu;
  for (const m of text.matchAll(re)) {
    // "Dr. Vidal", "J. K. Rowling", "e.g. Paris": a full stop after a title, an initial or a Latin abbreviation ends nothing.
    if (m[0][0] === "." && ABBREV.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
    const cut = m.index + m[0].length;
    push(from, cut);
    from = cut;
  }
  push(from, text.length);
  return out;
}

/**
 * The document's sentences ranked by how much of the claim they contain.
 * -> [{start, end, hits, share}] in document order, share = claim content words in the sentence / claim content words.
 */
export function rankSentences(doc, claim) {
  const want = contentStems(claim);
  return sentences(doc).map(({ start, end }) => {
    const got = contentStems(doc.slice(start, end));
    let hits = 0;
    for (const s of want) if (got.has(s)) hits++;
    return { start, end, hits, share: want.size ? hits / want.size : 0 };
  });
}

/** Offsets of the words in text[start,end) whose stems the claim also uses. */
export function matchedWords(text, start, end, claimStems) {
  const out = [];
  const part = text.slice(start, end);
  scanWords(part, (a, b) => {
    const lw = part.slice(a, b).toLowerCase();
    if (!STOP.has(lw) && claimStems.has(stemLower(lw))) out.push({ start: start + a, end: start + b });
  });
  return out;
}

/**
 * Cut text of length `len` at every span boundary.
 * spans: [{start, end}]. Returns contiguous segments covering [0, len), each
 * with `ids`: indices of the spans covering it, in the order given.
 */
export function segment(len, spans) {
  const cuts = new Set([0, len]);
  for (const { start, end } of spans) {
    cuts.add(Math.min(Math.max(start, 0), len));
    cuts.add(Math.min(Math.max(end, 0), len));
  }
  const edges = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const [a, b] = [edges[k], edges[k + 1]];
    const ids = [];
    spans.forEach((sp, i) => { if (sp.start <= a && sp.end >= b) ids.push(i); });
    out.push({ start: a, end: b, ids });
  }
  return out;
}

// ----------------------------------------------------------------- search

/** Search terms: words, or "quoted phrases" kept whole; lower-cased. */
export function terms(q) {
  const out = [];
  for (const m of String(q).matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One case-insensitive pattern per term (a phrase matches across any whitespace). */
export const termPatterns = (q) => terms(q).map((t) => new RegExp(escapeRegExp(t).replace(/\s+/g, "\\s+"), "iu"));

// ------------------------------------------------------------------ stats

/** Wilson score interval for k successes in n trials -> [lo, hi] in 0..1. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Area under the ROC curve of `scores` for telling positives (label 1) from
 * negatives: the chance a random positive outscores a random negative (ties count half).
 * NaN scores are left out. -> NaN when either class is empty.
 */
export function auroc(scores, labels) {
  const pairs = [];
  for (let i = 0; i < scores.length; i++) if (!Number.isNaN(scores[i])) pairs.push([scores[i], labels[i]]);
  pairs.sort((a, b) => a[0] - b[0]);
  let pos = 0, neg = 0, rankSum = 0;
  for (let i = 0; i < pairs.length;) {
    let j = i;
    while (j < pairs.length && pairs[j][0] === pairs[i][0]) j++;
    const midRank = (i + 1 + j) / 2;                    // 1-based average rank of the tie block
    let posHere = 0;
    for (let k = i; k < j; k++) if (pairs[k][1]) posHere++;
    pos += posHere; neg += j - i - posHere; rankSum += posHere * midRank;
    i = j;
  }
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}

/** Bin edges at the quantiles of `values`, de-duplicated (ties collapse bins). */
export function quantileEdges(values, k) {
  if (!values.length) return [];
  const v = Float64Array.from(values).sort();
  const edges = [];
  for (let i = 0; i <= k; i++) {
    const x = v[Math.min(v.length - 1, Math.floor((i / k) * (v.length - 1)))];
    if (!edges.length || x > edges[edges.length - 1]) edges.push(x);
  }
  return edges;
}

/** Index of the bin holding x: edges[i] <= x < edges[i+1]; the last bin is closed. */
export function binOf(edges, x) {
  const last = edges.length - 2;
  if (last < 0) return -1;
  let lo = 0, hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return Math.min(lo, last);
}

/** "Nice" axis ticks from 0 to at least `max`. -> {ticks, top} */
export function niceTicks(max, target = 4) {
  if (!(max > 0)) return { ticks: [0, 1], top: 1 };
  const raw = max / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(+t.toPrecision(12));
  return { ticks, top };
}

/** The q-quantile (0..1) of numeric values, linear between order statistics. */
export function quantile(values, q) {
  const v = Float64Array.from(values).filter((x) => !Number.isNaN(x)).sort();
  if (!v.length) return NaN;
  const at = q * (v.length - 1), i = Math.floor(at), f = at - i;
  return i + 1 < v.length ? v[i] + (v[i + 1] - v[i]) * f : v[i];
}

export const median = (values) => quantile(values, 0.5);

// ------------------------------------------------------------------- JSON

/**
 * Split (pretty-printed) JSON text into pieces for colouring:
 * [{kind, text}] with kind "key" | "str" | "num" | "lit", or "" for punctuation and whitespace.
 * Concatenating the texts gives back the input exactly.
 */
export function jsonTokens(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (m.index > last) out.push({ kind: "", text: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ kind: m[2] ? "key" : "str", text: m[1] });
      if (m[2]) out.push({ kind: "", text: m[2] });
    } else {
      out.push({ kind: /^[tfn]/.test(m[0]) ? "lit" : "num", text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "", text: text.slice(last) });
  return out;
}

// ----------------------------------------------------------------- format

export const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
export const fmtPct = (x, digits = 1) => (Number.isFinite(x) ? (x * 100).toFixed(digits) + "%" : "–");
export const fmtNum = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : "–");
export const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
