# LLM-AggreFact Viewer: a static site, no build step. Run `just` to list the recipes.

port := env("PORT", "8765")

# List the recipes.
default:
    @just --list

# Serve site/ at http://127.0.0.1:8765/ (with site/data/ present, the page opens with it).
run:
    python3 -m http.server {{ port }} --bind 127.0.0.1 --directory site

# Download the benchmark into site/data/ (git-ignored). Needs uv and a Hugging Face login with access to the dataset.
fetch-data:
    sh scripts/fetch-data.sh

# Run the tests (the real-data checks need `just fetch-data` first).
test:
    node --test

# Rewrite the test fixture: invented rows, written by pyarrow like the real files.
fixture:
    uv run scripts/make_fixture.py

# Recompute tests/real-data.digest from site/data/ with pyarrow.
digest:
    uv run scripts/digest.py
