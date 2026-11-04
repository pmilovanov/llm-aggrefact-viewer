# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow==21.0.0"]
# ///
"""Write tests/real-data.digest: one SHA-256 over every row of the pinned files, as pyarrow reads them.

    uv run scripts/digest.py      (needs `just fetch-data` first)

tests/real-data.test.mjs recomputes it from what the page's parquet reader returns,
so the test proves the reader gets every row exactly right without the repository
holding a single row. Row digest: SHA-1 of dataset, doc, claim, label and
contamination_identifier joined by NUL; the file digest: SHA-256 of the row digests,
one per line, dev then test.
"""

import hashlib
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
FIELDS = ["dataset", "doc", "claim", "label", "contamination_identifier"]

total = hashlib.sha256()
for split in ["dev", "test"]:
    t = pq.read_table(ROOT / "site" / "data" / f"{split}-00000-of-00001.parquet").to_pydict()
    for i in range(len(t["claim"])):
        row = "\0".join(str(t[f][i]) for f in FIELDS)
        total.update((hashlib.sha1(row.encode("utf-8")).hexdigest() + "\n").encode())
(ROOT / "tests" / "real-data.digest").write_text(total.hexdigest() + "\n")
print("wrote tests/real-data.digest")
