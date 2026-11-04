// Where the benchmark lives. Pinned to one commit, so ids (split-row) and
// numbers stay stable; keep in step with scripts/fetch-data.sh.

export const REPO = "lytang/LLM-AggreFact";
export const REV = "981dfd0bd8e58e7238a9ab92b2e6ea44bce918e4";
export const DATASET_PAGE = `https://huggingface.co/datasets/${REPO}`;
export const FILES = { dev: "dev-00000-of-00001.parquet", test: "test-00000-of-00001.parquet" };
/** Byte sizes of the pinned files: the download progress bar, and a check that a dropped file is the pinned one. */
export const SIZES = { [FILES.dev]: 35453136, [FILES.test]: 17298205 };
export const fileUrl = (name) => `${DATASET_PAGE}/resolve/${REV}/data/${name}`;
