#!/bin/sh
# Download LLM-AggreFact's two parquet files, pinned to one commit of the dataset,
# into site/data/ (git-ignored), where the page finds them when served locally.
#
# The dataset is gated. Accept its terms at
#   https://huggingface.co/datasets/lytang/LLM-AggreFact
# then either log in once (`uvx --from huggingface_hub hf auth login`) or set HF_TOKEN.
set -eu
cd "$(dirname "$0")/.."

REPO=lytang/LLM-AggreFact
REV=981dfd0bd8e58e7238a9ab92b2e6ea44bce918e4          # keep in step with site/js/config.js
DEV=dev-00000-of-00001.parquet
TEST=test-00000-of-00001.parquet

uvx --from huggingface_hub==2.2.0 hf download "$REPO" --repo-type dataset --revision "$REV" \
  "data/$DEV" "data/$TEST" --local-dir .hf-download --quiet >/dev/null

mkdir -p site/data
for f in "$DEV" "$TEST"; do cp ".hf-download/data/$f" "site/data/$f"; done

# The page shows a progress bar against these sizes; a mismatch means a different revision.
check() { [ "$(wc -c < "site/data/$1")" -eq "$2" ] || { echo "site/data/$1 is not the pinned file (size differs)" >&2; exit 1; }; }
check "$DEV" 35453136
check "$TEST" 17298205
echo "site/data/$DEV and site/data/$TEST are the pinned files (revision ${REV%"${REV#???????}"})."
