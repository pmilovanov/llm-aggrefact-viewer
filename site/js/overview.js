// Aggregate patterns over the current selection. Everything is broken down by
// subset: RAGTruth alone is over half the benchmark, so a pooled number would
// mostly describe RAGTruth (the benchmark's own score is a per-subset average too).

import { D, CHECKS } from "./data.js";
import { h } from "./ui.js";
import { card, tile, hbars, heatmap, barTable, labelColors } from "./charts.js";
import { fmtInt, fmtPct, fmtNum, median, auroc } from "./lib.js";

const LEN_EDGES = [0, 50, 100, 200, 400, 800, 1600, 3200];
const LEN_LABELS = ["≤50", "51–100", "101–200", "201–400", "401–800", "801–1.6k", "1.6k–3.2k", ">3.2k"];
/** Bin k holds LEN_EDGES[k] < words <= LEN_EDGES[k+1]; the last bin is open-ended. */
const lenBin = (w) => { let k = 0; while (k + 1 < LEN_EDGES.length && w > LEN_EDGES[k + 1]) k++; return k; };

const OV_LABELS = ["<20%", "20–40%", "40–60%", "60–80%", "80–99%", "100%"];
const ovBin = (x) => (x >= 1 ? 5 : Math.min(4, Math.floor(x * 5)));
const MIN_CELL = 10;      // fewer claims than this: no rate shown
const MIN_CLASS = 10;     // an AUROC needs this many of each label

/** Per-subset tallies of the selected rows. */
function tally(sel) {
  const S = D.f.subsets.map(() => ({
    n: 0, sup: 0, docs: new Map(), dw: [], cw: [], ov: [], lab: [],
    numSup: 0, numUns: 0, len: new Array(LEN_LABELS.length).fill(0),
    ovb: OV_LABELS.map(() => ({ n: 0, sup: 0 })), chk: CHECKS.map(() => 0),
  }));
  const all = { n: sel.length, sup: 0, docs: new Map(), split: D.f.splits.map(() => 0) };
  for (const i of sel) {
    const s = S[D.subset[i]], l = D.label[i], d = D.doc[i];
    s.n++; s.sup += l; all.sup += l; all.split[D.split[i]]++;
    s.docs.set(d, (s.docs.get(d) || 0) + 1);
    all.docs.set(d, (all.docs.get(d) || 0) + 1);
    s.dw.push(D.dw[i]); s.cw.push(D.cw[i]);
    s.len[lenBin(D.dw[i])]++;
    if (!Number.isNaN(D.ov[i])) {
      s.ov.push(D.ov[i]); s.lab.push(l);
      const b = s.ovb[ovBin(D.ov[i])]; b.n++; b.sup += l;
    }
    if (D.nm[i]) { if (l) s.numSup++; else s.numUns++; }
    CHECKS.forEach((c, k) => { if (D.chk[i] & c.bit) s.chk[k]++; });
  }
  for (const s of S) {
    const nPos = s.lab.filter(Boolean).length, nNeg = s.lab.length - nPos;
    s.auc = nPos >= MIN_CLASS && nNeg >= MIN_CLASS ? auroc(s.ov, s.lab) : NaN;
  }
  return { S, all };
}

export function mountOverview(root, { drill, selected }) {
  const tiles = h("div", { class: "tiles" });

  const subsetsCard = card({ title: "The eleven subsets", sub: "Size, label balance, length, and how far word overlap alone separates the labels", span: 12, tableToggle: false });
  const balanceCard = card({ title: "Supported and unsupported claims", sub: "Share of each subset's claims; click a bar to read them", span: 6 });
  const lengthCard = card({ title: "How long the documents are", sub: "Share of each subset's claims, by the length of their document in words", span: 6 });
  const overlapCard = card({ title: "Word overlap and the label", sub: "Share supported, by how much of the claim's wording its document contains", span: 6 });
  const numbersCard = card({ title: "Numbers the document never mentions", sub: "Claims containing a number (a year, an amount, a count) absent from their document", span: 6, tableToggle: false });
  const checksCard = card({ title: "Data checks", sub: "Rows worth a second look; click one to list them", span: 12, tableToggle: false });

  root.append(tiles, h("div", { class: "grid" },
    subsetsCard.el, balanceCard.el, lengthCard.el, overlapCard.el, numbersCard.el, checksCard.el));

  function render() {
    const sel = selected();
    const { S, all } = tally(sel);
    const live = D.f.subsets.map((name, k) => ({ name, k, s: S[k] })).filter((x) => x.s.n);
    const { sup: supC, uns: unsC } = labelColors();

    // ------------------------------------------------------------ tiles
    const perDoc = [...all.docs.values()];
    const rates = live.filter((x) => x.s.n >= MIN_CELL).map((x) => ({ name: x.name, v: x.s.sup / x.s.n }));
    const aucs = live.filter((x) => !Number.isNaN(x.s.auc)).map((x) => ({ name: x.name, v: x.s.auc }));
    const range = (xs, fmt) => {
      if (xs.length < 2) return null;
      const lo = xs.reduce((a, b) => (b.v < a.v ? b : a)), hi = xs.reduce((a, b) => (b.v > a.v ? b : a));
      return `from ${fmt(lo.v)} (${lo.name}) to ${fmt(hi.v)} (${hi.name})`;
    };
    tiles.replaceChildren(
      tile({ label: "Claims", value: fmtInt(all.n), sub: D.f.splits.map((s, k) => all.split[k] && `${s} ${fmtInt(all.split[k])}`).filter(Boolean).join(" · ") }),
      tile({ label: "Documents", value: fmtInt(all.docs.size), sub: perDoc.length ? `median ${fmtNum(median(perDoc), 0)} claim${median(perDoc) === 1 ? "" : "s"} each, up to ${fmtInt(Math.max(...perDoc))}` : "" }),
      tile({ label: "Supported", value: all.n ? fmtPct(all.sup / all.n, 0) : "–", sub: range(rates, (v) => fmtPct(v, 0)) ? `by subset, ${range(rates, (v) => fmtPct(v, 0))}` : "" }),
      tile({ label: "Word overlap vs label, mean AUROC", value: aucs.length ? fmtNum(aucs.reduce((a, b) => a + b.v, 0) / aucs.length) : "–",
        sub: aucs.length ? range(aucs, (v) => fmtNum(v)) || `${aucs.length} subset` : "needs both labels in the selection" }),
    );

    if (!sel.length) {
      for (const c of [subsetsCard, balanceCard, lengthCard, overlapCard, numbersCard, checksCard]) c.set({ empty: c.empty });
      return;
    }

    // ------------------------------------------------------------ subsets table
    const link = (x) => h("button", { class: "linkish", type: "button", title: `Read the ${x.name} claims`, onclick: () => drill({ subset: x.k }) }, x.name);
    subsetsCard.set({
      draw: (box) => box.replaceChildren(barTable({
        head: ["Subset", "Claims", "Documents", "Claims per doc", "Supported", "Doc words", "Claim words", "Overlap AUROC"],
        rows: live.map((x) => [
          link(x), fmtInt(x.s.n), fmtInt(x.s.docs.size), fmtNum(median([...x.s.docs.values()]), 0),
          { text: fmtPct(x.s.sup / x.s.n, 0), bar: x.s.sup / x.s.n },
          fmtInt(median(x.s.dw)), fmtInt(median(x.s.cw)),
          Number.isNaN(x.s.auc) ? "–" : { text: fmtNum(x.s.auc), bar: Math.max(0, (x.s.auc - 0.5) / 0.5) },
        ]),
        barColor: "var(--t0)",
      })),
      table: { head: [], rows: [] },
      note: "Medians throughout. Overlap AUROC: how well the share of a claim's content words found in its document ranks supported above unsupported claims (0.5 is chance, 1 is perfect). It needs no model at all, so a high value means the subset is partly solvable by matching words.",
    });

    // ------------------------------------------------------------ label balance
    const pctLabel = (v) => (v >= 0.08 ? fmtPct(v, 0) : "");
    balanceCard.set({
      legend: [{ label: "Supported", color: supC }, { label: "Unsupported", color: unsC }],
      draw: (box) => hbars(box, {
        rows: live.map((x) => {
          const ps = x.s.sup / x.s.n, pu = 1 - ps;
          return {
            label: x.name, sub: `${fmtInt(x.s.n)} claims`,
            segs: [
              { value: ps, color: supC, label: pctLabel(ps), tip: { title: x.name, rows: [{ color: supC, label: "supported", value: `${fmtPct(ps)} (${fmtInt(x.s.sup)})` }] }, onClick: () => drill({ subset: x.k, label: "supported" }) },
              { value: pu, color: unsC, label: pctLabel(pu), tip: { title: x.name, rows: [{ color: unsC, label: "unsupported", value: `${fmtPct(pu)} (${fmtInt(x.s.n - x.s.sup)})` }] }, onClick: () => drill({ subset: x.k, label: "unsupported" }) },
            ],
          };
        }),
        max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmtTick: (t) => fmtPct(t, 0), labelWidth: 132,
      }),
      table: { head: ["Subset", "Claims", "Supported", "Unsupported", "Share supported"],
        rows: live.map((x) => [x.name, fmtInt(x.s.n), fmtInt(x.s.sup), fmtInt(x.s.n - x.s.sup), fmtPct(x.s.sup / x.s.n)]) },
      note: "The balance differs enormously between subsets, which is why the benchmark scores balanced accuracy, per subset.",
    });

    // ------------------------------------------------------------ document length
    lengthCard.set({
      draw: (box) => heatmap(box, {
        rowLabels: live.map((x) => x.name), colLabels: LEN_LABELS, labelWidth: 120, max: 1, scaleLabel: "share of the subset's claims",
        cells: live.map((x) => x.s.len.map((c, k) => (c ? {
          value: c / x.s.n, text: c / x.s.n < 0.005 ? "<1%" : fmtPct(c / x.s.n, 0),
          tip: { title: `${x.name}: ${LEN_LABELS[k]} words`, rows: [{ label: "of the subset's claims", value: `${fmtPct(c / x.s.n)} (${fmtInt(c)})` }] },
        } : null))),
      }),
      table: { head: ["Subset", ...LEN_LABELS], rows: live.map((x) => [x.name, ...x.s.len.map((c) => (c ? `${fmtPct(c / x.s.n, 1)} (${fmtInt(c)})` : "–"))]) },
      note: "Words as written, not model tokens. Long documents are where a checker's context limit bites; some subsets are mostly short evidence snippets, others mostly long pages.",
    });

    // ------------------------------------------------------------ overlap vs label
    overlapCard.set({
      draw: (box) => heatmap(box, {
        rowLabels: live.map((x) => x.name), colLabels: OV_LABELS, labelWidth: 120, max: 1, scaleLabel: "share supported",
        cells: live.map((x) => x.s.ovb.map((b, k) => (b.n >= MIN_CELL ? {
          value: b.sup / b.n, text: fmtPct(b.sup / b.n, 0),
          tip: { title: `${x.name}: overlap ${OV_LABELS[k]}`, rows: [{ label: "supported", value: `${fmtPct(b.sup / b.n)} of ${fmtInt(b.n)}` }] },
        } : null))),
      }),
      table: { head: ["Subset", ...OV_LABELS], rows: live.map((x) => [x.name, ...x.s.ovb.map((b) => (b.n ? `${fmtPct(b.sup / b.n)} of ${fmtInt(b.n)}` : "–"))]) },
      note: `Overlap: the share of a claim's content words (lower-cased, crudely stemmed, stop words dropped) that occur anywhere in its document. – marks fewer than ${MIN_CELL} claims.`,
    });

    // ------------------------------------------------------------ numbers
    numbersCard.set({
      draw: (box) => box.replaceChildren(barTable({
        head: ["Subset", "of supported claims", "of unsupported claims"],
        rows: live.map((x) => {
          const ns = x.s.sup, nu = x.s.n - x.s.sup;
          return [x.name,
            ns ? { text: fmtPct(x.s.numSup / ns, 0), bar: x.s.numSup / ns } : "–",
            nu ? { text: fmtPct(x.s.numUns / nu, 0), bar: x.s.numUns / nu } : "–"];
        }),
        barColor: unsC,
      })),
      table: { head: [], rows: [] },
      note: "A number in the claim that the document never writes is a strong hint of an unsupported claim, but not proof: documents spell numbers out, round them, or convert units.",
    });

    // ------------------------------------------------------------ data checks
    const totals = CHECKS.map((_, k) => live.reduce((n, x) => n + x.s.chk[k], 0));
    checksCard.set({
      draw: (box) => box.replaceChildren(barTable({
        head: ["Check", "Claims", "Where"], align: ["l", "", "l"],
        rows: CHECKS.map((c, k) => [
          totals[k] ? h("button", { class: "linkish", type: "button", title: c.tip, onclick: () => drill({ check: c.bit }) }, c.label) : h("span", { title: c.tip }, c.label),
          fmtInt(totals[k]),
          live.filter((x) => x.s.chk[k]).sort((a, b) => b.s.chk[k] - a.s.chk[k]).slice(0, 4).map((x) => `${x.name} ${fmtInt(x.s.chk[k])}`).join(" · ") || "–",
        ]),
      })),
      table: { head: [], rows: [] },
      note: CHECKS.map((c) => `${c.label}: ${c.tip.toLowerCase()}.`).join(" "),
    });
  }

  return { render };
}
