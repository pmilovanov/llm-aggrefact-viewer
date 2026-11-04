// The first screen when this browser has no copy of the benchmark yet: why the
// page ships without it, and two ways to bring your own.

import { h } from "./ui.js";
import { DATASET_PAGE, FILES, SIZES, fileUrl } from "./config.js";
import { fmtBytes } from "./lib.js";

export function mountGetData(root, { error, load }) {
  const status = h("p", { class: "boot-status" });
  const bar = h("progress", { max: 1, hidden: true });
  const err = h("p", { class: "gd-error", role: "alert", hidden: !error }, error ? `Could not read the stored copy: ${error}` : "");
  let busy = false;

  async function run(args, what) {
    if (busy) return;
    busy = true;
    err.hidden = true;
    bar.hidden = false;
    bar.removeAttribute("value");
    status.textContent = what;
    panel.classList.add("busy");
    try {
      await load(args);
    } catch (e) {
      err.textContent = String(e.message || e);
      err.hidden = false;
      bar.hidden = true;
      status.textContent = "";
      panel.classList.remove("busy");
      busy = false;
    }
  }

  async function takeFiles(list) {
    const files = [...list].filter((f) => /\.parquet$/i.test(f.name));
    if (!files.length) { err.textContent = "Those are not .parquet files. You need the two files from the dataset's data/ folder."; err.hidden = false; return; }
    const read = await Promise.all(files.map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })));
    run({ from: "files", files: read }, `Reading ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
  }

  const picker = h("input", { type: "file", accept: ".parquet", multiple: true, hidden: true, onchange: () => takeFiles(picker.files) });
  const drop = h("div", { class: "drop", tabindex: 0, role: "button", "aria-label": "Choose the parquet files",
    onclick: () => picker.click(),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } } },
    h("strong", {}, "Drop the two .parquet files here"), h("span", {}, "or click to choose them"));

  // Dropping anywhere on the page counts, not only on the box.
  const over = (e) => { e.preventDefault(); drop.classList.add("over"); };
  const leave = () => drop.classList.remove("over");
  const onDrop = (e) => { e.preventDefault(); leave(); if (e.dataTransfer?.files?.length) takeFiles(e.dataTransfer.files); };
  addEventListener("dragover", over);
  addEventListener("dragleave", leave);
  addEventListener("drop", onDrop);

  const token = h("input", { class: "search", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "hf_…", "aria-label": "Hugging Face access token" });
  const tokenForm = h("form", { class: "gd-token", onsubmit: (e) => {
    e.preventDefault();
    const t = token.value;
    token.value = "";                                   // not kept, not even in the field
    run({ from: "hf", token: t }, "Contacting Hugging Face…");
  } }, token, h("button", { class: "btn", type: "submit" }, "Fetch"));

  const fileLink = (name) => h("a", { href: `${fileUrl(name)}?download=true`, rel: "noopener" }, name);

  const panel = h("div", { class: "getdata" },
    h("h2", {}, "Bring your own copy of LLM-AggreFact"),
    h("p", { class: "gd-why" },
      "The benchmark's authors ask that it never be put where web crawlers can read it, so this page comes without the data. ",
      "You load your own copy; it is read here, in your browser, and kept only in this browser's storage."),
    h("ol", { class: "gd-steps" },
      h("li", {}, "On the ", h("a", { href: DATASET_PAGE, rel: "noopener", target: "_blank" }, "dataset's page"), ", log in and accept its terms (it is for evaluation only)."),
      h("li", {}, "Download ", fileLink(FILES.dev), ` (${fmtBytes(SIZES[FILES.dev])}) and `, fileLink(FILES.test), ` (${fmtBytes(SIZES[FILES.test])}).`),
      h("li", {}, "Give them to this page:")),
    drop, picker,
    h("details", { class: "gd-more" },
      h("summary", {}, "Or fetch them with a Hugging Face access token"),
      h("p", { class: "dim" }, "The token is sent to huggingface.co and nowhere else, and is not kept. A read-only token is enough, from an account that has accepted the terms."),
      tokenForm),
    bar, status, err,
    h("p", { class: "boot-note" }, "Next time the page opens straight away; the Data button in the header can forget the copy."));

  root.replaceChildren(panel);
  root.classList.add("gd");
  return {
    dispose() {
      removeEventListener("dragover", over); removeEventListener("dragleave", leave); removeEventListener("drop", onDrop);
    },
  };
}
