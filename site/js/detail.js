// One claim in full: the claim, its label, its document with the sentences
// closest to it in wording, and every other claim made about that document.

import { D, getDetail, getRecord, CHECKS } from "./data.js";
import { FILES } from "./config.js";
import { h } from "./ui.js";
import { segment, jsonTokens, fmtInt, fmtPct } from "./lib.js";

const LABELS = { 1: ["Supported", "sup"], 0: ["Unsupported", "uns"] };

/** "Supported" / "Unsupported", in the label colours (a mark as well as a colour). */
export function labelChip(label, small = false) {
  const [text, cls] = LABELS[label];
  return h("span", { class: `chip lab lab-${cls}${small ? " tiny" : ""}` }, h("b", { "aria-hidden": "true" }, label ? "✓" : "✗"), text);
}

// ------------------------------------------------------------------- JSON

const pretty = (v) => JSON.stringify(v, null, 2);

function flash(btn, text, back) {
  btn.textContent = text;
  setTimeout(() => { btn.textContent = back; }, 1400);
}

async function copyText(btn, text, back) {
  try { await navigator.clipboard.writeText(text); flash(btn, "Copied", back); }
  catch { flash(btn, "Copy failed", back); }
}

/** Pretty-printed JSON as coloured text nodes, one block per line so long strings wrap under their key. */
function jsonBlock(value) {
  const frag = document.createDocumentFragment();
  let line;
  const newLine = () => frag.append(line = h("span", { class: "jl" }));
  newLine();
  for (const { kind, text } of jsonTokens(pretty(value))) {
    if (kind) { line.append(h("span", { class: `j-${kind}` }, text)); continue; }
    text.split("\n").forEach((part, k) => {
      if (k) newLine();
      if (!line.firstChild) line.style.setProperty("--in", `${part.length - part.trimStart().length}ch`);
      if (part) line.append(part);
    });
  }
  return frag;
}

function showRecord(rec, id, split) {
  if (document.querySelector("dialog.json-dialog")) return;
  const copyBtn = h("button", { class: "btn small", type: "button", onclick: () => copyText(copyBtn, pretty(rec), "Copy") }, "Copy");
  const dlg = h("dialog", { class: "json-dialog", "aria-label": `JSON for ${id}` },
    h("header", { class: "json-head" },
      h("span", { class: "json-title" }, id),
      h("div", { class: "json-actions" }, copyBtn, h("button", { class: "btn small", type: "button", onclick: () => dlg.close() }, "Close"))),
    h("p", { class: "json-note" }, `Row ${id.slice(split.length + 1)} of ${FILES[split] || `the ${split} file`}, as stored. The label is an int64 there.`),
    h("pre", { class: "json", tabindex: 0 }, jsonBlock(rec)));
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
}

// --------------------------------------------------------------- document

const MODES = [["sentences", "Closest sentences"], ["words", "Matching words"], ["off", "Off"]];

/** Up to three sentences sharing the most content words with the claim (at least half as many as the best). */
function closest(sentences) {
  const best = Math.max(0, ...sentences.map((s) => s.hits));
  if (!best) return [];
  return sentences.map((s, i) => ({ ...s, i })).filter((s) => s.hits >= Math.max(1, Math.ceil(best / 2)))
    .sort((a, b) => b.hits - a.hits || a.start - b.start).slice(0, 3);
}

function docText(d, mode) {
  const top = mode === "sentences" ? closest(d.sentences) : [];
  const inTop = (w) => top.some((s) => w.start >= s.start && w.end <= s.end);
  const words = mode === "off" ? [] : mode === "words" ? d.words : d.words.filter(inTop);
  const spans = [...top.map((s, k) => ({ start: s.start, end: s.end, kind: k === 0 ? "best" : "near", rank: k })), ...words.map((w) => ({ ...w, kind: "w" }))];
  const box = h("div", { class: "doc" });
  if (!d.doc.trim()) { box.append(h("p", { class: "null" }, "This document is blank.")); return box; }
  for (const seg of segment(d.doc.length, spans)) {
    const text = d.doc.slice(seg.start, seg.end);
    const kinds = new Set(seg.ids.map((i) => spans[i].kind));
    if (!kinds.size) { box.append(text); continue; }
    const cls = [kinds.has("best") ? "ev best" : kinds.has("near") ? "ev" : "", kinds.has("w") ? "mw" : ""].filter(Boolean).join(" ");
    const sent = seg.ids.map((i) => spans[i]).find((sp) => sp.rank != null);
    box.append(h("mark", { class: cls, dataset: sent ? { s: sent.rank } : null }, text));
  }
  return box;
}

// ----------------------------------------------------------------- the view

export function mountDetail(root, { navigate }) {
  let token = 0, mode = "sentences", last = null;

  async function show(id) {
    const mine = ++token;
    root.classList.add("loading");
    let d;
    try { d = await getDetail(id); }
    catch (e) { if (mine === token) clear(String(e.message || e)); return; }
    if (mine !== token) return;
    root.classList.remove("loading");
    last = d;
    render(d);
  }

  function render(d) {
    const at = d.mates.findIndex((m) => m.id === d.id);
    const prev = d.mates[at - 1], next = d.mates[at + 1];

    // The row as the file has it; fetched now so Copy JSON can copy at once.
    let recordText = null;
    const record = getRecord(d.id);
    record.then((r) => { recordText = pretty(r); }).catch(() => {});
    const copy = h("button", { class: "btn small", type: "button", title: "Copy this row as JSON",
      onclick: async () => copyText(copy, recordText ?? pretty(await record), "Copy JSON") }, "Copy JSON");
    const viewJson = h("button", { class: "btn small", type: "button", dataset: { action: "view-json" }, title: "This row as stored in the file (v)",
      onclick: async () => showRecord(await record, d.id, d.split) }, "View JSON");

    const checks = CHECKS.filter((c) => d.checks & c.bit).map((c) => h("span", { class: "chip warn", title: c.tip }, h("b", {}, "!"), c.label));

    const docBody = h("div", { class: "src-body" });
    const paintDoc = () => {
      docBody.replaceChildren(docText(d, mode));
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.mode === mode)));
      nextBtn.disabled = targets().length < 2;
      requestAnimationFrame(() => jump(0));
    };
    // "Next" walks the closest sentences from best to least, or the matching words in reading order.
    let hop = 0;
    const targets = () => {
      if (mode === "words") return [...docBody.querySelectorAll("mark.mw")];
      const first = new Map();
      for (const m of docBody.querySelectorAll("mark[data-s]")) if (!first.has(+m.dataset.s)) first.set(+m.dataset.s, m);
      return [...first.keys()].sort((a, b) => a - b).map((k) => first.get(k));
    };
    const jump = (k) => {
      const t = targets();
      if (!t.length) { docBody.scrollTop = 0; return; }
      hop = ((k % t.length) + t.length) % t.length;
      docBody.scrollTop = Math.max(0, t[hop].offsetTop - 60);
    };
    const tabs = MODES.map(([m, text]) => h("button", { class: "tab", type: "button", role: "tab", dataset: { mode: m }, onclick: () => { mode = m; paintDoc(); } }, text));
    const nextBtn = h("button", { class: "btn small", type: "button", title: "Scroll to the next highlighted passage", onclick: () => jump(hop + 1) }, "Next");

    const ovText = Number.isNaN(d.overlap) ? "The claim has no content words to compare."
      : `${fmtPct(d.overlap, 0)} of the claim's content words appear somewhere in the document.`;

    const matesList = d.mates.length > 1 && h("section", { class: "mates" },
      h("h3", { class: "mates-h" }, `Claims about this document (${fmtInt(d.mates.length)})`),
      h("p", { class: "sub" }, `${fmtInt(d.mates.filter((m) => m.label).length)} supported, ${fmtInt(d.mates.filter((m) => !m.label).length)} unsupported`),
      h("ol", { class: "mate-list" }, d.mates.map((m) => h("li", {},
        h("button", { class: "mate" + (m.id === d.id ? " cur" : ""), type: "button", "aria-current": m.id === d.id ? "true" : null, onclick: () => navigate(m.id) },
          labelChip(m.label, true), h("span", { class: "mate-claim" }, m.claim), h("small", { class: "mate-id" }, m.subset !== d.subset ? `${m.id} · ${m.subset}` : m.id))))));

    const view = h("div", { class: "detail" },
      h("header", { class: "d-head" },
        h("div", { class: "d-title" }, h("h2", {}, d.id), labelChip(d.label),
          h("span", { class: "chip plain strong" }, d.subset), h("span", { class: "chip plain" }, d.split), ...checks),
        h("div", { class: "d-actions" },
          h("button", { class: "btn small", type: "button", disabled: !prev, title: "Previous claim about this document (←)", onclick: () => navigate(prev.id) }, "←"),
          h("button", { class: "btn small", type: "button", disabled: !next, title: "Next claim about this document (→)", onclick: () => navigate(next.id) }, "→"),
          viewJson, copy)),
      h("div", { class: "d-cols" },
        h("div", { class: "d-left" },
          h("section", { class: `claim-box lab-${d.label ? "sup" : "uns"}` },
            h("p", { class: "claim-kicker" }, "Claim"),
            h("p", { class: "claim-text" }, d.claim)),
          h("ul", { class: "facts" },
            h("li", {}, ovText),
            d.missingNumbers.length > 0 && h("li", {}, `${d.missingNumbers.length === 1 ? "A number" : "Numbers"} in the claim the document never mentions: `,
              h("b", {}, d.missingNumbers.join(", ")), "."),
            h("li", { class: "dim" }, "Measured on wording alone, as a reading aid. The label is the benchmark's, made by its annotators.")),
          matesList),
        h("section", { class: "d-src", "aria-label": "Document" },
          h("div", { class: "src-head" },
            h("span", { class: "src-title" }, "Document"),
            h("span", { class: "src-meta" }, `${fmtInt(d.docWords)} words`),
            h("span", { class: "grow" }),
            h("div", { class: "src-tabs", role: "tablist", "aria-label": "Highlight" }, ...tabs), nextBtn),
          docBody)));
    root.replaceChildren(view);
    paintDoc();
  }

  function clear(message) {
    token++;
    root.classList.remove("loading");
    root.replaceChildren(h("div", { class: "empty" }, message));
  }

  return { show, clear, rerender: () => last && render(last) };
}
