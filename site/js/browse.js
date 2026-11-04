// The list/detail view: a virtualised list of the selected claims beside the
// full view of the one under the cursor.

import { D, rowInfo } from "./data.js";
import { h, download, csvCell } from "./ui.js";
import { fmtInt, fmtPct } from "./lib.js";
import { mountDetail, labelChip } from "./detail.js";

const ROW_H = 76;
const ov = (i) => (Number.isNaN(D.ov[i]) ? -1 : D.ov[i]);

const SORTS = {
  order: { label: "Dataset order", cmp: (a, b) => a - b },
  lowov: { label: "Least word overlap", cmp: (a, b) => ov(a) - ov(b) || a - b },
  highov: { label: "Most word overlap", cmp: (a, b) => ov(b) - ov(a) || a - b },
  longdoc: { label: "Longest document", cmp: (a, b) => D.dw[b] - D.dw[a] || a - b },
  shortdoc: { label: "Shortest document", cmp: (a, b) => D.dw[a] - D.dw[b] || a - b },
  busy: { label: "Most claims per document", cmp: (a, b) => D.docN[D.doc[b]] - D.docN[D.doc[a]] || D.doc[a] - D.doc[b] || a - b },
};

export function mountBrowse(root, { selected, navigate }) {
  let sort = "order", order = new Int32Array(0), cur = -1, shown = null;

  const count = h("span", { class: "list-count" });
  const sortSel = h("select", { class: "ctl", "aria-label": "Sort", onchange: (e) => { sort = e.target.value; resort(); } },
    Object.entries(SORTS).map(([k, v]) => h("option", { value: k }, v.label)));
  const vp = h("div", { class: "vlist", tabindex: 0, role: "listbox", "aria-label": "Claims" });
  const space = h("div", { class: "vspace" });
  const rowsEl = h("div", { class: "vrows" });
  space.append(rowsEl);
  vp.append(space);

  const randomBtn = h("button", { class: "btn small", type: "button", title: "Jump to a random claim in this list", onclick: () => {
    if (order.length) navigate(D.ids[order[Math.floor(Math.random() * order.length)]]);
  } }, "Random");
  // Ids and numbers only: the export is for joining with your own copy, not a way to spread the benchmark's text.
  const csvBtn = h("button", { class: "btn small", type: "button", title: "Download the filtered list as CSV (ids and measurements, no text)", onclick: () => {
    const head = ["id", "split", "row", "subset", "label", "doc_words", "claim_words", "claims_on_doc", "word_overlap", "numbers_not_in_doc", "checks"];
    const lines = [head.join(",")];
    for (const r of order) {
      const i = rowInfo(r);
      lines.push([i.id, i.split, D.idx[r], i.subset, i.label, i.docWords, D.cw[r], i.claimsOnDoc,
        Number.isNaN(i.overlap) ? "" : i.overlap.toFixed(3), i.missingNumbers, i.checks].map(csvCell).join(","));
    }
    download("llm-aggrefact-selection.csv", lines.join("\n") + "\n");
  } }, "CSV");

  const pane = h("section", { class: "detail-pane", "aria-live": "polite" });
  const detail = mountDetail(pane, { navigate });

  const list = h("aside", { class: "list-pane" },
    h("div", { class: "list-head" }, count, h("div", { class: "list-tools" }, sortSel, randomBtn, csvBtn)),
    vp,
    h("p", { class: "list-help" }, h("kbd", {}, "j"), " ", h("kbd", {}, "k"), " move · ", h("kbd", {}, "←"), " ", h("kbd", {}, "→"),
      " same document · ", h("kbd", {}, "/"), " search"));
  root.append(list, pane);

  // ------------------------------------------------------------ list

  function rowEl(r) {
    const i = rowInfo(r);
    return h("div", {
      class: "row" + (r === cur ? " cur" : ""), role: "option", "aria-selected": r === cur ? "true" : "false", tabindex: -1,
      style: { height: `${ROW_H}px` }, dataset: { row: r },
      onclick: () => navigate(i.id),
    },
      h("div", { class: "row-top" },
        h("span", { class: "rid" }, i.id), labelChip(i.label, true),
        h("span", { class: "rsub" }, i.subset)),
      h("div", { class: "row-claim" }, i.claim),
      h("div", { class: "row-sub" },
        `${fmtInt(i.docWords)} words`,
        i.claimsOnDoc > 1 && ` · ${fmtInt(i.claimsOnDoc)} claims`,
        h("span", { class: "dim" }, ` · overlap ${Number.isNaN(i.overlap) ? "–" : fmtPct(i.overlap, 0)}`),
        i.missingNumbers > 0 && h("span", { class: "dim" }, " · number not in doc")));
  }

  let queued = false;
  function paint() {
    queued = false;
    const top = vp.scrollTop, view = vp.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5), last = Math.min(order.length, Math.ceil((top + view) / ROW_H) + 5);
    rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
    rowsEl.replaceChildren(...Array.from(order.subarray(first, last), rowEl));
  }
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  vp.addEventListener("scroll", schedule);
  new ResizeObserver(schedule).observe(vp);

  function resort() {
    order = Int32Array.from(selected()).sort(SORTS[sort].cmp);
    space.style.height = `${order.length * ROW_H}px`;
    count.textContent = `${fmtInt(order.length)} of ${fmtInt(D.n)} claims`;
    paint();
  }

  function reveal() {
    const at = order.indexOf(cur);
    if (at < 0) return;
    const y = at * ROW_H, view = vp.clientHeight;
    if (y < vp.scrollTop) vp.scrollTop = y;
    else if (y + ROW_H > vp.scrollTop + view) vp.scrollTop = y + ROW_H - view;
  }

  function step(delta) {
    if (!order.length) return;
    const at = order.indexOf(cur);
    const next = at < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + delta));
    navigate(D.ids[order[next]]);
  }

  return {
    /** Rebuild the list from the current selection, pointing it at the route's id. -> {first id, is the route's id in the list} */
    update(routeId) {
      cur = routeId != null ? (D.rowOfId.get(routeId) ?? -1) : -1;
      resort();
      return { first: order.length ? D.ids[order[0]] : null, inList: cur >= 0 && order.indexOf(cur) >= 0 };
    },
    /** Point the list at `id`; the detail is rebuilt only if the id changed. */
    show(id) {
      cur = D.rowOfId.get(id) ?? -1;
      if (cur < 0) { shown = null; detail.clear(`No claim with id ${id}.`); return; }
      paint();
      reveal();
      if (shown !== id) { shown = id; detail.show(id); }
    },
    empty() { cur = -1; shown = null; paint(); detail.clear("No claims match the current filters."); },
    step,
    /** The previous/next claim about the same document, in file order. */
    mates(delta) {
      if (cur < 0) return;
      const d = D.doc[cur], rows = D.docRows.subarray(D.docOff[d], D.docOff[d + 1]);
      const next = rows[Array.prototype.indexOf.call(rows, cur) + delta];
      if (next != null) navigate(D.ids[next]);
    },
  };
}
