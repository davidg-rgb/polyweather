"""
iem-backfill — historical METAR/SPECI (resolution-grade) obs for every market
station, from IEM's asos.py per-observation feed (free; matches WU exactly —
validated 66/66, docs/DATA-SOURCES.md §resolution-oracle).

One ranged request per station (NOT per station-day — polite), report_type=3,4
(3=routine METAR, 4=SPECI — exactly the rows WU renders; NEVER 1=5-min or
2=DSM). Rows land in out/iem-asos-archive/{ICAO}.ndjson, merge-idempotent on
the UTC valid timestamp, so re-runs only extend the window.

Usage:
    python scripts/research/iem-backfill.py                # default: last 90 days, all 45 stations
    python scripts/research/iem-backfill.py --days 180
    python scripts/research/iem-backfill.py --start 2026-04-01 --end 2026-07-25
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

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--start", type=str, default=None)
    ap.add_argument("--end", type=str, default=None)
    args = ap.parse_args()
    end = date.fromisoformat(args.end) if args.end else date.today()
    start = date.fromisoformat(args.start) if args.start else end - timedelta(days=args.days)
    # ±1 day pad so every station-LOCAL day in range is fully covered in UTC
    d0, d1 = start - timedelta(days=1), end + timedelta(days=2)

    total_new = 0
    for slug, (icao, _tz, _unit, cc, us_state) in sorted(CITY_MAP.items()):
        path = OUT / f"{icao}.ndjson"
        existing: dict[str, list] = {}
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    r = json.loads(line)
                    existing[r[0]] = r
        try:
            rows = fetch_range(icao, cc, us_state, d0, d1)
        except Exception as e:
            print(f"  ✗ {slug:14s} {icao}: fetch failed ({e})", file=sys.stderr)
            continue
        new = 0
        for r in rows:
            if r[0] not in existing:
                existing[r[0]] = r
                new += 1
        if new or not path.exists():
            with path.open("w", encoding="utf-8") as f:
                for k in sorted(existing):
                    f.write(json.dumps(existing[k]) + "\n")
        total_new += new
        print(f"  ✓ {slug:14s} {icao}: {len(rows)} rows fetched, {new} new, {len(existing)} total")
        time.sleep(1.5)  # be polite
    print(f"DONE: {total_new} new rows across {len(CITY_MAP)} stations → {OUT}")

if __name__ == "__main__":
    main()
