"""
iem-backfill — historical METAR/SPECI (resolution-grade) obs for every market
station, from IEM's asos.py per-observation feed (free; matches WU exactly —
validated 66/66, docs/DATA-SOURCES.md §resolution-oracle).

One ranged request per station (NOT per station-day — polite), report_type=3,4
(3=routine METAR, 4=SPECI — exactly the rows WU renders; NEVER 1=5-min or
2=DSM). Rows land in out/iem-asos-archive/{ICAO}.ndjson, merge-idempotent on
the UTC valid timestamp, so re-runs only extend the window.

Ranges are fetched in per-calendar-year chunks (one request per station-year —
polite to IEM for multi-year climatology pulls; chunk boundaries overlap one day
and the merge dedupes). Per-station coverage lands in out/iem-asos-archive/
_coverage.json — thin/gappy years at intl stations are recorded, never fatal.

Usage:
    python scripts/research/iem-backfill.py                # default: last 90 days, all 45 stations
    python scripts/research/iem-backfill.py --days 180
    python scripts/research/iem-backfill.py --start 2021-01-01 --end 2026-07-25
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

# Windows consoles/pipes default to cp1252 — the ✓/⚠ glyphs below would crash the run
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out" / "iem-asos-archive"
OUT.mkdir(parents=True, exist_ok=True)
CITY_MAP = json.loads((ROOT / "city-map.json").read_text(encoding="utf-8"))["cities"]

def iem_station(icao: str, cc: str, us_state: str | None) -> tuple[str, str]:
    """(station, network) — the iemNetworkFor (core/weather/iem.ts) convention."""
    if cc == "US":
        return icao[1:], f"{us_state}_ASOS"
    return icao, f"{cc}__ASOS"

def fetch_range(icao: str, cc: str, us_state: str | None, d0: date, d1: date) -> list[list]:
    station, network = iem_station(icao, cc, us_state)
    qs = urllib.parse.urlencode({
        "station": station, "network": network, "data": "tmpf,tmpc",
        "year1": d0.year, "month1": d0.month, "day1": d0.day,
        "year2": d1.year, "month2": d1.month, "day2": d1.day,
        "tz": "Etc/UTC", "format": "onlycomma", "latlon": "no", "elev": "no",
        "missing": "M", "trace": "T", "direct": "no", "report_type": "3,4",
    })
    url = f"https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "polyweather-research (iem backfill; contact: repo operator)"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        text = resp.read().decode("utf-8", "replace")
    rows = []
    for line in text.splitlines()[1:]:
        parts = line.split(",")
        if len(parts) < 4:
            continue
        valid, tmpf, tmpc = parts[1], parts[2], parts[3]
        try:
            rows.append([valid, float(tmpf) if tmpf not in ("M", "T", "") else None,
                         float(tmpc) if tmpc not in ("M", "T", "") else None])
        except ValueError:
            continue
    return rows

def year_chunks(d0: date, d1: date) -> list[tuple[date, date]]:
    """Per-calendar-year [c0, c1] chunks covering [d0, d1]; boundaries overlap one
    day (chunk end = Jan 1 next year) — safe because the merge is idempotent."""
    chunks = []
    for y in range(d0.year, d1.year + 1):
        c0, c1 = max(d0, date(y, 1, 1)), min(d1, date(y + 1, 1, 1))
        if c0 <= c1:
            chunks.append((c0, c1))
    return chunks

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--start", type=str, default=None)
    ap.add_argument("--end", type=str, default=None)
    ap.add_argument("--stations", type=str, default=None,
                    help="comma-separated city slugs (default: all) — for re-pulling a failed chunk")
    args = ap.parse_args()
    only = set(s.strip() for s in args.stations.split(",")) if args.stations else None
    end = date.fromisoformat(args.end) if args.end else date.today()
    start = date.fromisoformat(args.start) if args.start else end - timedelta(days=args.days)
    # ±1 day pad so every station-LOCAL day in range is fully covered in UTC
    d0, d1 = start - timedelta(days=1), end + timedelta(days=2)
    chunks = year_chunks(d0, d1)

    total_new = 0
    coverage: dict[str, dict] = {}
    for slug, (icao, _tz, _unit, cc, us_state) in sorted(CITY_MAP.items()):
        if only is not None and slug not in only:
            continue
        path = OUT / f"{icao}.ndjson"
        existing: dict[str, list] = {}
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    r = json.loads(line)
                    existing[r[0]] = r
        new, failed_chunks = 0, []
        for (c0, c1) in chunks:
            rows = None
            for attempt in (1, 2):
                try:
                    rows = fetch_range(icao, cc, us_state, c0, c1)
                    break
                except Exception as e:
                    if attempt == 2:
                        failed_chunks.append(f"{c0.isoformat()}..{c1.isoformat()} ({e})")
                    else:
                        time.sleep(5.0)
            if rows is not None:
                for r in rows:
                    if r[0] not in existing:
                        existing[r[0]] = r
                        new += 1
            time.sleep(1.5)  # be polite
        if new or not path.exists():
            with path.open("w", encoding="utf-8") as f:
                for k in sorted(existing):
                    f.write(json.dumps(existing[k]) + "\n")
        total_new += new
        by_year: dict[str, int] = {}
        for k in existing:
            by_year[k[:4]] = by_year.get(k[:4], 0) + 1
        keys = sorted(existing)
        coverage[slug] = {
            "icao": icao, "rows": len(existing),
            "first": keys[0][:10] if keys else None,
            "last": keys[-1][:10] if keys else None,
            "byYear": dict(sorted(by_year.items())),
            "failedChunks": failed_chunks,
        }
        gap = f" ⚠ {len(failed_chunks)} failed chunk(s)" if failed_chunks else ""
        print(f"  ✓ {slug:14s} {icao}: {new} new, {len(existing)} total"
              f" ({coverage[slug]['first']}..{coverage[slug]['last']}){gap}", flush=True)
    # a --stations subset run MERGES into the existing coverage record instead of clobbering it
    cov_path = OUT / "_coverage.json"
    if only is not None and cov_path.exists():
        prior = json.loads(cov_path.read_text(encoding="utf-8")).get("stations", {})
        prior.update(coverage)
        coverage = prior
    cov_path.write_text(
        json.dumps({"_generated": date.today().isoformat(),
                    "window": [d0.isoformat(), d1.isoformat()],
                    "stations": coverage}, indent=1), encoding="utf-8")
    print(f"DONE: {total_new} new rows across {len(CITY_MAP)} stations → {OUT}")

if __name__ == "__main__":
    main()
