"""
csv-to-parquet — convert market-history-flat.csv.gz → Parquet for repeated analysis / model training.

WHY Parquet (not the .csv.gz the flatten step writes): when ONE large file is read MANY times
(repeated training passes, feature sweeps, convergence/efficiency runs), Parquet wins decisively:
  - columnar  → a pass that needs only {t, p, secs_to_resolution} reads 3 columns, not all 9
  - per-column compression + dictionary encoding → low-cardinality cols (city, label, outcome)
    collapse hard; the file is a fraction of the csv.gz
  - predicate / row-group pushdown → `filter city='london'` skips other cities' bytes on disk
  - out-of-core → pyarrow.dataset streams row-groups; the 247M-row set never needs to fit in RAM
A .csv.gz must be fully re-decompressed and re-parsed, every row, every column, on EVERY pass.

Bounded memory: streams the gzip CSV in row chunks (default 2M rows) and appends to the Parquet
file via ParquetWriter — it never materializes the full table. With `--partition city` it writes a
Hive-partitioned dataset (…/market-history-flat.parquet/city=london/*.parquet) so per-city training
scans a single directory.

Usage:
  python scripts/research/csv-to-parquet.py                         # out/market-history-flat.csv.gz → .parquet
  python scripts/research/csv-to-parquet.py --partition city        # city-partitioned dataset
  python scripts/research/csv-to-parquet.py --p32                   # store p as float32 (halves that column)
  python scripts/research/csv-to-parquet.py --in X.csv.gz --out Y.parquet --compression snappy --chunk-rows 1000000

Requires: pyarrow, pandas (installed: the "parquet engine").
"""

import argparse
import sys
import time
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq

# The columns flatten-market-history.ts emits, in order. Explicit dtypes — never let pandas guess
# per-chunk (guessing risks a dtype drift between chunks that corrupts the Parquet schema).
COLUMNS = [
    "city", "target_date", "event_id", "end_ts",
    "bucket_idx", "label", "resolved_outcome", "t", "p",
]


def build_schema(p32: bool) -> pa.Schema:
    return pa.schema([
        ("city", pa.string()),
        ("target_date", pa.string()),
        ("event_id", pa.string()),
        ("end_ts", pa.int64()),       # event resolution epoch (s)
        ("bucket_idx", pa.int16()),   # 0..~30 buckets per event
        ("label", pa.string()),       # e.g. "80-81°F"  (nullable)
        ("resolved_outcome", pa.string()),  # 'win' | 'lose' | null
        ("t", pa.int64()),            # price-point epoch (s)
        ("p", pa.float32() if p32 else pa.float64()),  # implied prob 0..1
    ])


def pandas_dtypes(p32: bool) -> dict:
    # int columns are always present (never NaN) so plain int dtypes are safe in read_csv.
    return {
        "city": "string", "target_date": "string", "event_id": "string",
        "end_ts": "int64", "bucket_idx": "int16",
        "label": "string", "resolved_outcome": "string",
        "t": "int64", "p": "float32" if p32 else "float64",
    }


def chunks(inp: Path, p32: bool, chunk_rows: int):
    """Yield (RecordBatch, n_rows) from the gzip CSV, schema-coerced, bounded memory."""
    schema = build_schema(p32)
    reader = pd.read_csv(
        inp,
        compression="gzip",
        encoding="utf-8",          # flatten-market-history.ts writes utf-8 (Node default); labels carry "°F"
        dtype=pandas_dtypes(p32),
        usecols=COLUMNS,           # ignore any extra cols defensively
        chunksize=chunk_rows,
        keep_default_na=True,      # empty label/outcome -> <NA> -> parquet null
    )
    for df in reader:
        # from_pandas with an explicit schema enforces identical types across every chunk
        batch = pa.RecordBatch.from_pandas(df[COLUMNS], schema=schema, preserve_index=False)
        yield batch, len(df)


def convert_single(inp: Path, out: Path, comp: str, p32: bool, chunk_rows: int) -> int:
    schema = build_schema(p32)
    rows = 0
    out.parent.mkdir(parents=True, exist_ok=True)
    writer = pq.ParquetWriter(out, schema, compression=comp)
    try:
        for batch, n in chunks(inp, p32, chunk_rows):
            writer.write_table(pa.Table.from_batches([batch], schema=schema))
            rows += n
            print(f"  ...{rows:,} rows", end="\r", flush=True)
    finally:
        writer.close()
    return rows


def convert_partitioned(inp: Path, out_dir: Path, comp: str, p32: bool, chunk_rows: int) -> int:
    schema = build_schema(p32)
    rows = 0
    counter = {"n": 0}

    def gen():
        for batch, n in chunks(inp, p32, chunk_rows):
            rows_local = batch.num_rows
            counter["n"] += rows_local
            print(f"  ...{counter['n']:,} rows", end="\r", flush=True)
            yield batch

    # Hive flavor → directories named `city=<value>/` (auto-detected by DuckDB/Polars/Spark/pyarrow).
    # A bare list (`partitioning=["city"]`) would instead emit `<value>/` (directory flavor), which
    # most readers do NOT auto-detect — so be explicit.
    part = ds.partitioning(pa.schema([("city", pa.string())]), flavor="hive")
    ds.write_dataset(
        gen(),
        base_dir=str(out_dir),
        schema=schema,
        format="parquet",
        partitioning=part,
        existing_data_behavior="delete_matching",
        file_options=ds.ParquetFileFormat().make_write_options(compression=comp),
        basename_template="part-{i}.parquet",
    )
    return counter["n"]


def main() -> int:
    # Windows consoles default to cp1252; force utf-8 so help text / data labels ("°F") never crash.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass

    here = Path(__file__).resolve().parent
    default_in = here / "out" / "market-history-flat.csv.gz"

    ap = argparse.ArgumentParser(description="Convert market-history-flat.csv.gz -> Parquet.")
    ap.add_argument("--in", dest="inp", default=str(default_in), help="input .csv.gz")
    ap.add_argument("--out", dest="out", default=None, help="output .parquet (or dir if --partition)")
    ap.add_argument("--partition", choices=["city"], default=None, help="write a partitioned dataset")
    ap.add_argument("--compression", default="zstd", choices=["zstd", "snappy", "gzip", "none"])
    ap.add_argument("--p32", action="store_true", help="store p as float32 (lossy ~7 sig-figs, half size)")
    ap.add_argument("--chunk-rows", type=int, default=2_000_000)
    args = ap.parse_args()

    inp = Path(args.inp)
    if not inp.exists():
        sys.exit(f"input not found: {inp}\n  run `pnpm tsx scripts/research/flatten-market-history.ts` first")

    comp = None if args.compression == "none" else args.compression
    t0 = time.time()

    if args.partition:
        out = Path(args.out) if args.out else inp.with_suffix("").with_suffix(".parquet")
        print(f"csv-to-parquet (partitioned by {args.partition}) -> {out}")
        rows = convert_partitioned(inp, out, comp, args.p32, args.chunk_rows)
        size = sum(f.stat().st_size for f in out.rglob("*.parquet"))
    else:
        out = Path(args.out) if args.out else inp.with_suffix("").with_suffix(".parquet")
        print(f"csv-to-parquet -> {out}")
        rows = convert_single(inp, out, comp, args.p32, args.chunk_rows)
        size = out.stat().st_size

    dt = time.time() - t0
    print(
        f"\n=== done: {rows:,} rows -> {out}\n"
        f"    {size / 1e6:.0f} MB parquet ({comp or 'uncompressed'}, p={'f32' if args.p32 else 'f64'}) "
        f"in {dt:.1f}s ==="
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
