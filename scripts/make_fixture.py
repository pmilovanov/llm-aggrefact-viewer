# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow==21.0.0"]
# ///
"""Write the test fixture: a miniature LLM-AggreFact in the real files' shape.

    uv run scripts/make_fixture.py

Every text here is invented. No row of the real benchmark may enter this
repository (see README, "Why the data is not here").

Out come tests/fixtures/{dev,test}-00000-of-00001.parquet, written by pyarrow as
the real files were (snappy, dictionary-encoded strings, several row groups),
and tests/fixtures/expected.json: the rows exactly as pyarrow reads them back,
which the JavaScript reader must reproduce.
"""

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

SCHEMA = pa.schema([
    ("dataset", pa.string()),
    ("doc", pa.string()),
    ("claim", pa.string()),
    ("label", pa.int64()),
    ("contamination_identifier", pa.string()),
])

HARBOUR = (
    "The town council met on Tuesday to discuss the harbour wall. "
    "Engineers said the wall was built in 1931 and last repaired in 1987.\n\n"
    "Councillor Ames proposed a budget of 2.4 million pounds for the repairs. "
    "The motion passed by seven votes to two. Work is expected to begin in spring."
)
BAKERY = (
    "Q: When does the bakery open?\n"
    "A: Our café opens at 7 a.m. on weekdays and 8 a.m. at weekends. "
    "We bake sourdough every morning 🍞 and close at 3 p.m."
)
COMET = (
    "Astronomers in Chile observed a faint comet on 3 March. "
    "Its orbit takes roughly 240 years. The comet was named after the observatory's founder, Dr. Rosa Vidal. "
    "It will be visible with binoculars until late April."
)
TEA = "Matcha is a powdered green tea. It is traditionally whisked with hot water, not boiled. 抹茶 means \"rubbed tea\"."
PLAIN = "Short note: the museum is closed on Mondays."
VOLCANO = "The volcano last erupted in 1902. Scientists monitor it with seismometers."
MATCHA = "抹茶 (matcha) means \"rubbed tea\" in Japanese."
PARK = "The park is closed on Mondays and on public holidays."
LIBRARY = "The library roof will be repaired. The work, costing 2.4 million pounds, begins in spring."


def cid(n: int) -> str:
    """A stand-in for the 64-character contamination identifier."""
    return f"{n:064x}"


DEV = [
    ("AggreFact-CNN", HARBOUR, "The harbour wall was built in 1931.", 1),
    ("AggreFact-CNN", HARBOUR, "The wall was last repaired in 1997.", 0),
    ("AggreFact-CNN", HARBOUR, "The motion passed by seven votes to two.", 1),
    ("TofuEval-MeetB", HARBOUR, "Councillor Ames opposed the budget.", 0),
    ("RAGTruth", BAKERY, "The café opens at 7 a.m. on weekdays.", 1),
    ("RAGTruth", BAKERY, "The bakery is open on Sundays until 6 p.m.", 0),
    ("RAGTruth", BAKERY, "They bake sourdough every morning 🍞.", 1),
    ("Wice", COMET, "The comet's orbit takes about 240 years.", 1),
    ("Wice", COMET, "The comet was discovered by Dr. Rosa Vidal.", 0),
    ("Reveal", TEA, "Matcha is whisked with hot water.", 1),
    ("Reveal", TEA, "Matcha is whisked with hot water.", 0),      # the same pair, labelled both ways
    ("ExpertQA", PLAIN, "The museum is closed on Mondays.", 1),
    ("ExpertQA", "", "An empty document supports nothing.", 0),
]

TEST = [
    ("AggreFact-XSum", VOLCANO, "The volcano last erupted in 1902.", 1),
    ("AggreFact-XSum", VOLCANO, "The volcano erupted twice last year.", 0),
    ("TofuEval-MediaS", BAKERY, "The café closes at 3 p.m.", 1),   # the only document in both splits
    ("ClaimVerify", MATCHA, "抹茶 means rubbed tea.", 1),
    ("FactCheck-GPT", PARK, "The park opens every day.", 0),
    ("Lfqa", LIBRARY, "Repairs to the library roof begin in spring.", 1),
    ("Lfqa", LIBRARY, "The repairs will cost 4.2 million pounds.", 0),
]


def write(rows, name, start):
    table = pa.table(
        {
            "dataset": [r[0] for r in rows],
            "doc": [r[1] for r in rows],
            "claim": [r[2] for r in rows],
            "label": [r[3] for r in rows],
            "contamination_identifier": [cid(start + i) for i in range(len(rows))],
        },
        schema=SCHEMA,
    )
    pq.write_table(table, OUT / f"{name}-00000-of-00001.parquet", compression="snappy", row_group_size=4)
    return pq.read_table(OUT / f"{name}-00000-of-00001.parquet").to_pylist()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    expected = {"dev": write(DEV, "dev", 0), "test": write(TEST, "test", 1000)}
    (OUT / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print({k: len(v) for k, v in expected.items()})


if __name__ == "__main__":
    main()
