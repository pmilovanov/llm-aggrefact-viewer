// Shell: finds the data (or asks for it), owns the route
// (#/overview, #/browse/<split>-<row>?<filters>) and the one shared selection.

import { initTheme, toggleTheme, h, $ } from "./ui.js";
import { D, F, loadData, forgetData, select, onChange, emit, filtersToParams, paramsToFilters, applyQuery } from "./data.js";
import { mountFilters } from "./filters.js";
import { mountOverview } from "./overview.js";
import { mountBrowse } from "./browse.js";
import { mountGetData } from "./getdata.js";
import { fmtInt, fmtBytes } from "./lib.js";

initTheme();

let selection = null;
const selected = () => (selection ||= select());

let route = { view: "overview", id: null, params: new URLSearchParams() };
let lastBrowse = null;
let filters, overview, browse;

// ------------------------------------------------------------------ routing

function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const view = parts[0] === "browse" ? "browse" : "overview";
  return { view, id: view === "browse" ? parts[1] ?? null : null, params: new URLSearchParams(query) };
}

function hashFor({ view, id }) {
  let path = `#/${view}`;
  if (view === "browse" && id != null) path += `/${encodeURIComponent(id)}`;
  const q = filtersToParams().toString();
  return q ? `${path}?${q}` : path;
}

function navigate(view, id = null, { replace = false } = {}) {
  const hash = hashFor({ view, id });
  if (view === "browse") lastBrowse = id;
  if (replace) { history.replaceState(null, "", hash); apply(); }
  else if (location.hash === hash) apply();
  else location.hash = hash;
}

const navigateToClaim = (id) => navigate("browse", id);

/** True while the URL, not a click, is what changed the filters. */
let fromUrl = false;

async function apply() {
  route = parseHash();
  if (route.params.toString() === filtersToParams().toString()) return show();
  const { q, scope } = paramsToFilters(route.params);
  selection = null;
  fromUrl = true;
  try {
    if (q !== F.q || scope !== F.scope) await applyQuery(q, scope);
    else emit();
  } finally {
    fromUrl = false;
  }
}

function show({ fromFilter = false } = {}) {
  const isBrowse = route.view === "browse";
  $("#overview").hidden = isBrowse;
  $("#browse").hidden = !isBrowse;
  document.querySelectorAll(".tabbtn").forEach((b) => b.setAttribute("aria-selected", String((b.dataset.view === "browse") === isBrowse)));
  filters.sync();
  if (!isBrowse) { overview.render(); return; }
  const { first, inList } = browse.update(route.id);
  if (first == null) { browse.empty(); return; }
  // No id yet, or a filter just excluded the one on screen: land on the list's first entry.
  // (A shared deep link to an id outside its own filters is shown as given.)
  if (route.id == null || (fromFilter && !inList)) return navigate("browse", first, { replace: true });
  lastBrowse = route.id;
  browse.show(route.id);
}

onChange(() => {
  selection = null;
  if (!fromUrl) history.replaceState(null, "", hashFor(route));
  show({ fromFilter: !fromUrl });
});

/** Overview click-throughs: narrow some filters, then read the claims. */
function drill({ subset, label, check }) {
  if (subset !== undefined) { F.subset.clear(); F.subset.add(subset); }
  if (label !== undefined) F.label = label;
  if (check !== undefined) { F.checks.clear(); F.checks.add(check); }
  selection = null;
  navigate("browse", null);
}

// ---------------------------------------------------------------- shortcuts

const typing = (e) => e.target.closest?.("input, select, textarea, [contenteditable]") != null;

addEventListener("keydown", (e) => {
  if (!D.ready || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector("dialog[open]")) return;           // a modal has the keyboard
  if (e.key === "Escape") { document.activeElement?.blur?.(); return; }
  if (typing(e)) return;
  const inBrowse = route.view === "browse";
  switch (e.key) {
    case "/": e.preventDefault(); filters.focusSearch(); break;
    case "1": navigate("overview"); break;
    case "2": navigate("browse", lastBrowse); break;
    case "t": toggleTheme(); break;
    case "j": if (inBrowse) browse.step(1); break;
    case "k": if (inBrowse) browse.step(-1); break;
    case "ArrowDown": case "ArrowUp":
      if (inBrowse && e.target.closest?.(".vlist")) { e.preventDefault(); browse.step(e.key === "ArrowDown" ? 1 : -1); }
      break;
    case "ArrowLeft": case "ArrowRight":
      if (inBrowse && !e.target.closest?.("svg")) browse.mates(e.key === "ArrowRight" ? 1 : -1);
      break;
    case "v": if (inBrowse) document.querySelector('[data-action="view-json"]')?.click(); break;
    default:
  }
});

addEventListener("hashchange", () => { if (D.ready) apply(); });
addEventListener("themechange", () => { if (D.ready && route.view === "overview") overview.render(); });

// --------------------------------------------------------------------- data

function progressText(p) {
  if (p.stage === "download") {
    const where = { local: "Reading the local copy in site/data/", hf: "Downloading from Hugging Face" }[p.where] || "Loading";
    return { value: p.loaded / p.total, text: `${where}… ${Math.floor((100 * p.loaded) / p.total)}%` };
  }
  return { value: null, text: p.split ? `Reading the ${p.split} split…` : "Reading the files…" };
}

function showProgress(p) {
  const bar = $("#boot progress"), status = $("#boot .boot-status");
  if (!bar) return;
  const { value, text } = progressText(p);
  if (value == null) bar.removeAttribute("value"); else bar.value = value;
  status.textContent = text;
}

/** The header's Data button: where the data came from, and a way to forget it. */
function dataDialog() {
  if (document.querySelector("dialog.data-dialog")) return;
  const s = D.source;
  const from = { stored: "this browser's storage, saved on an earlier visit", local: "site/data/ on this machine", files: "files you chose", hf: "Hugging Face, with your token" }[s.from];
  const forget = h("button", { class: "btn small", type: "button", onclick: async () => {
    forget.disabled = true;
    try { await forgetData(); location.reload(); } catch (e) { forget.textContent = `Could not: ${e.message}`; }
  } }, "Forget it");
  const dlg = h("dialog", { class: "json-dialog data-dialog", "aria-label": "About the data" },
    h("header", { class: "json-head" }, h("span", { class: "json-title" }, "Your copy of LLM-AggreFact"),
      h("div", { class: "json-actions" }, h("button", { class: "btn small", type: "button", onclick: () => dlg.close() }, "Close"))),
    h("div", { class: "data-body" },
      h("p", {}, `Loaded from ${from}.`),
      h("ul", {}, s.files.map((f) => h("li", {}, h("code", {}, f.name), ` · ${f.split} · ${fmtBytes(f.size)}`,
        f.pinned ? h("span", { class: "dim" }, " · the pinned release") : h("b", {}, " · not the pinned release: ids and numbers may differ from shared links")))),
      s.saved && s.from !== "local"
        ? h("p", {}, "It is kept in this browser's storage, so the next visit needs no download. It never leaves this machine. ", forget)
        : s.from === "local" ? h("p", { class: "dim" }, "Served from this machine; nothing is stored in the browser.")
          : h("p", { class: "dim" }, "This browser would not store it, so the next visit will ask again.")));
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
}

function start() {
  $("#boot").remove();
  $("#tagline").textContent = `${fmtInt(D.n)} claims · ${fmtInt(D.nDocs)} documents · ${D.f.subsets.length} subsets`;
  $("#data").hidden = false;
  document.querySelector(".tabs").hidden = false;
  $("#data").addEventListener("click", dataDialog);
  filters = mountFilters($("#filters"), { selectedCount: () => selected().length });
  overview = mountOverview($("#overview"), { drill, selected });
  browse = mountBrowse($("#browse"), { selected, navigate: navigateToClaim });
  document.querySelectorAll(".tabbtn").forEach((b) => b.addEventListener("click", () =>
    (b.dataset.view === "browse" ? navigate("browse", lastBrowse) : navigate("overview"))));
  apply();
}

async function main() {
  $("#theme").addEventListener("click", toggleTheme);
  // ?data=local insists on site/data/; ?data=none skips it (to test the get-data screen locally).
  const prefer = new URLSearchParams(location.search).get("data") || undefined;
  let res = null;
  try { res = await loadData({ from: "auto", prefer }, showProgress); }
  catch (e) { res = { needData: true, error: String(e.message || e) }; }
  if (!res.needData) return start();
  const screen = mountGetData($("#boot"), {
    error: res.error,
    load: async (args) => { await loadData(args, showProgress); screen.dispose(); start(); },
  });
}

main();
