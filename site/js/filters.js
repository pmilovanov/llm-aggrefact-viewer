// The filter bar: one set of controls that scopes every chart, table and list.

import { D, F, CHECKS, emit, applyQuery, resetFilters, activeFilterCount } from "./data.js";
import { h, debounce } from "./ui.js";
import { fmtInt } from "./lib.js";

const SCOPES = [["both", "claims and documents"], ["claim", "claims"], ["doc", "documents"]];

export function mountFilters(root, { selectedCount }) {
  const facet = (title, key, names) => h("div", { class: "fgroup", role: "group", "aria-label": title },
    h("span", { class: "flabel" }, title),
    ...names.map((name, code) => h("button", {
      class: "chip tog", type: "button", "aria-pressed": "false", dataset: { facet: key, code },
      onclick: () => { F[key].has(code) ? F[key].delete(code) : F[key].add(code); emit(); },
    }, String(name))));

  const label = h("div", { class: "fgroup", role: "group", "aria-label": "Label" },
    h("span", { class: "flabel" }, "Label"),
    ...[["any", "Any"], ["supported", "Supported"], ["unsupported", "Unsupported"]].map(([v, text]) => h("button", {
      class: "chip tog" + (v === "any" ? "" : ` lab-${v === "supported" ? "sup" : "uns"}`), type: "button", "aria-pressed": "false", dataset: { label: v },
      onclick: () => { F.label = v; emit(); },
    }, text)));

  const input = h("input", {
    class: "search", type: "search", placeholder: "Search…  (all words must match; “quote” a phrase)", "aria-label": "Search text", id: "search",
    oninput: debounce(() => applyQuery(input.value, scope.value), 250),
  });
  const scope = h("select", { class: "ctl", "aria-label": "Search in", onchange: () => input.value.trim() && applyQuery(input.value, scope.value) },
    SCOPES.map(([v, text]) => h("option", { value: v }, `in ${text}`)));

  const readout = h("span", { class: "readout", "aria-live": "polite" });
  const reset = h("button", { class: "btn small", type: "button", onclick: () => { resetFilters(); syncInputs(); emit(); } }, "Reset");

  const checks = h("div", { class: "fgroup", role: "group", "aria-label": "Data checks" },
    h("span", { class: "flabel" }, "Data checks"),
    ...CHECKS.map((c) => h("button", {
      class: "chip tog", type: "button", "aria-pressed": "false", title: c.tip, dataset: { check: c.bit },
      onclick: () => { F.checks.has(c.bit) ? F.checks.delete(c.bit) : F.checks.add(c.bit); emit(); },
    }, c.label)));
  const num = h("button", {
    class: "chip tog", type: "button", "aria-pressed": "false",
    title: "Claims that contain a number (a year, an amount, a count) appearing nowhere in their document",
    onclick: () => { F.num = !F.num; emit(); },
  }, "Number not in document");

  const more = h("div", { class: "frow more", hidden: true }, checks, h("div", { class: "fgroup" }, h("span", { class: "flabel" }, "Wording"), num));
  const moreBtn = h("button", { class: "btn small", type: "button", "aria-expanded": "false", onclick: () => {
    more.hidden = !more.hidden;
    moreBtn.setAttribute("aria-expanded", String(!more.hidden));
  } }, "More filters");

  // On a narrow screen the facets fold away behind this button (see style.css).
  const body = h("div", { class: "fbody" },
    h("div", { class: "frow" }, facet("Subset", "subset", D.f.subsets), facet("Split", "split", D.f.splits), label, moreBtn),
    more);
  const fold = h("button", { class: "btn small ftoggle", type: "button", "aria-expanded": "false", onclick: () => {
    body.classList.toggle("open");
    fold.setAttribute("aria-expanded", String(body.classList.contains("open")));
  } }, "Filters");

  root.append(h("div", { class: "frow" }, input, scope, fold, h("span", { class: "grow" }), readout, reset), body);

  function syncInputs() {
    input.value = F.q;
    scope.value = F.scope;
  }

  /** Reflect F in the controls; call after any change to F. */
  function sync() {
    root.querySelectorAll("[data-facet]").forEach((b) => b.setAttribute("aria-pressed", String(F[b.dataset.facet].has(+b.dataset.code))));
    root.querySelectorAll("[data-label]").forEach((b) => b.setAttribute("aria-pressed", String(F.label === b.dataset.label)));
    root.querySelectorAll("[data-check]").forEach((b) => b.setAttribute("aria-pressed", String(F.checks.has(+b.dataset.check))));
    num.setAttribute("aria-pressed", String(F.num));
    const extra = F.checks.size + (F.num ? 1 : 0);
    moreBtn.textContent = extra ? `More filters (${extra})` : "More filters";
    if (extra && more.hidden) { more.hidden = false; moreBtn.setAttribute("aria-expanded", "true"); }
    const active = activeFilterCount();
    reset.disabled = !active;
    const facets = active - (F.q ? 1 : 0);
    fold.textContent = facets ? `Filters (${facets})` : "Filters";
    readout.textContent = `${fmtInt(selectedCount())} of ${fmtInt(D.n)} claims`;
  }

  return { sync, syncInputs, focusSearch: () => input.focus() };
}
