"""
oracle-replica-validation — empirical test of the polymarket-temp-oracle claims
(operator-supplied doc, 2026-07-25) against OUR data.

Claims under test (the load-bearing ones for this project):
  C1. WU's Daily Observations table == the METAR/SPECI stream, so
      max(round_half_up(tmpf)) over IEM asos.py rows (report_type 3,4)
      reproduces the market's resolved winner bucket.
  C2. The 5-min obs stream (our Synoptic corpus) is NOT part of the resolution
      table — its running max can exceed the METAR-table max (the mechanism
      behind OBS-TRANSMISSION's 19 winner-"kills").
  C3. Therefore: METAR-grade kills carry ~zero fabrication risk where the
      5-min-grade kills fabricated.

Data: IEM asos.py per-ob feed (free) x the resolved market-history archive x
the synoptic 5-min obs archive, 11 US cities, 2026-07-19..25.

Usage: python scripts/research/oracle-replica-validation.py
Output: per-day table + RESULT {json} on the last line.
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
OBS_DIR = ROOT / "out" / "synoptic-obs-archive"
MH_DIR = ROOT / "out" / "market-history"
CACHE_DIR = ROOT / "out" / "iem-asos-cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

DAY_LO, DAY_HI = "2026-07-19", "2026-07-25"

# city -> (icao, tz, IEM 3-letter id, state network)
CITY_STATION = {
    "atlanta": ("KATL", "America/New_York", "ATL", "GA_ASOS"),
    "austin": ("KAUS", "America/Chicago", "AUS", "TX_ASOS"),
    "chicago": ("KORD", "America/Chicago", "ORD", "IL_ASOS"),
    "dallas": ("KDAL", "America/Chicago", "DAL", "TX_ASOS"),
    "denver": ("KBKF", "America/Denver", "BKF", "CO_ASOS"),
    "houston": ("KHOU", "America/Chicago", "HOU", "TX_ASOS"),
    "los-angeles": ("KLAX", "America/Los_Angeles", "LAX", "CA_ASOS"),
    "miami": ("KMIA", "America/New_York", "MIA", "FL_ASOS"),
    "nyc": ("KLGA", "America/New_York", "LGA", "NY_ASOS"),
    "san-francisco": ("KSFO", "America/Los_Angeles", "SFO", "CA_ASOS"),
    "seattle": ("KSEA", "America/Los_Angeles", "SEA", "WA_ASOS"),
}

def wu_round(x: float) -> int:
    """WU display rounding: half away from zero (units.ts wuRound mirror)."""
    return int(math.copysign(math.floor(abs(x) + 0.5), x))

def c_to_f_native(c: float) -> int:
    return wu_round(c * 9 / 5 + 32)

def parse_label_f(label: str) -> tuple[float, float]:
    nums = [int(n) for n in re.findall(r"\d+", label)]
    lo, hi = -math.inf, math.inf
    if "below" in label or "lower" in label:
        hi = nums[0]
    elif "higher" in label or "above" in label:
        lo = nums[0]
    elif len(nums) >= 2:
        lo, hi = nums[0], nums[1]
    elif nums:
        lo = hi = nums[0]
    return lo, hi

def fetch_iem(station: str, network: str, day: str, tz: str) -> list[tuple[datetime, float]]:
    """IEM asos.py per-ob tmpf rows (report_type 3=routine METAR, 4=SPECI),
    UTC-fetched a day wide on each side, bucketed to the station-local day by caller."""
    cache = CACHE_DIR / f"{station}-{day}.json"
    if cache.exists():
        rows = json.loads(cache.read_text())
    else:
        d0 = datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)
        d1 = d0 + timedelta(days=3)
        qs = urllib.parse.urlencode({
            "station": station, "network": network, "data": "tmpf",
            "year1": d0.year, "month1": d0.month, "day1": d0.day,
            "year2": d1.year, "month2": d1.month, "day2": d1.day,
            "tz": "Etc/UTC", "format": "onlycomma", "latlon": "no", "elev": "no",
            "missing": "M", "trace": "T", "direct": "no", "report_type": "3,4",
        })
        url = f"https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?{qs}"
        req = urllib.request.Request(url, headers={"User-Agent": "polyweather-research (oracle validation)"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", "replace")
        rows = []
        for line in text.splitlines()[1:]:
            parts = line.split(",")
            if len(parts) < 3 or parts[2] in ("M", "T", ""):
                continue
            try:
                rows.append([parts[1], float(parts[2])])
            except ValueError:
                continue
        cache.write_text(json.dumps(rows))
        time.sleep(1.0)  # be polite
    tzinfo = ZoneInfo(tz)
    out = []
    for iso, tmpf in rows:
        dt = datetime.strptime(iso, "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo("UTC"))
        out.append((dt.astimezone(tzinfo), tmpf))
    return out

def load_synoptic_max(icao: str, tz: str, day: str) -> int | None:
    """Native-°F running max of the 5-min corpus for the local day (the OBS-TRANSMISSION basis)."""
    tzinfo = ZoneInfo(tz)
    mx = None
    for f in sorted(OBS_DIR.glob("*.ndjson")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip() or f'"{icao}"' not in line:
                continue
            r = json.loads(line)
            if r["icao"] != icao:
                continue
            dt = datetime.fromisoformat(r["obs_at"].replace("Z", "+00:00")).astimezone(tzinfo)
            if dt.strftime("%Y-%m-%d") != day:
                continue
            v = c_to_f_native(float(r["temp_tenths_c"]))
            mx = v if mx is None else max(mx, v)
    return mx

def load_markets() -> dict[tuple[str, str], dict]:
    months = ["january","february","march","april","may","june","july",
              "august","september","october","november","december"]
    out: dict[tuple[str, str], dict] = {}
    for city in CITY_STATION:
        d = MH_DIR / city
        if not d.is_dir():
            continue
        for f in d.glob("*.json"):
            ev = json.loads(f.read_text(encoding="utf-8"))
            m = re.search(r"on-([a-z]+)-(\d+)(?:-(\d{4}))?$", ev.get("slug", ""))
            if not m or not m.group(3):
                continue
            day = f"{m.group(3)}-{months.index(m.group(1)) + 1:02d}-{int(m.group(2)):02d}"
            if not (DAY_LO <= day <= DAY_HI):
                continue
            winner = next((b["label"] for b in ev["buckets"] if b.get("resolvedOutcome") == "win"), None)
            if winner:
                out[(city, day)] = {"winner": winner,
                                    "labels": [b["label"] for b in ev["buckets"]]}
    return out

def main() -> None:
    markets = load_markets()
    days = sorted({d for (_, d) in markets})
    rows_out = []
    n_match = n_total = n_syn_over = n_syn_days = 0

    for (city, day), mk in sorted(markets.items()):
        icao, tz, iem_id, network = CITY_STATION[city]
        try:
            obs = fetch_iem(iem_id, network, day, tz)
        except Exception as e:
            print(f"   {city} {day}: IEM fetch failed ({e})", file=sys.stderr)
            continue
        day_rows = [(dt, tmpf) for (dt, tmpf) in obs if dt.strftime("%Y-%m-%d") == day]
        if not day_rows:
            continue
        # C1: WU replica = max over per-row half-up rounding of tmpf
        replica_max = max(wu_round(tmpf) for _, tmpf in day_rows)
        lo, hi = parse_label_f(mk["winner"])
        ok = lo <= replica_max <= hi
        n_total += 1
        n_match += ok
        # C2: synoptic 5-min max vs the METAR-table max
        syn_max = load_synoptic_max(icao, tz, day)
        syn_over = None
        if syn_max is not None:
            n_syn_days += 1
            syn_over = syn_max - replica_max
            if syn_max > replica_max:
                n_syn_over += 1
        rows_out.append({"city": city, "day": day, "replicaMax": replica_max,
                         "winner": mk["winner"], "match": ok,
                         "synMax": syn_max, "synOver": syn_over, "nRows": len(day_rows)})
        flag = "OK " if ok else "MISS"
        print(f"   {flag} {city:14s} {day}  metarTableMax={replica_max:3d}F"
              f" winner='{mk['winner']}' synMax={syn_max} over={syn_over} rows={len(day_rows)}")

    print(f"\nC1 winner-replication: {n_match}/{n_total} = {n_match / n_total:.1%}" if n_total else "no days")
    print(f"C2 synoptic-max EXCEEDS metar-table max on {n_syn_over}/{n_syn_days} covered days"
          f" ({n_syn_over / n_syn_days:.1%})" if n_syn_days else "")
    misses = [r for r in rows_out if not r["match"]]
    if misses:
        print("MISSES:", json.dumps(misses, indent=1))
    (ROOT / "out" / "oracle-replica-validation.json").write_text(json.dumps(rows_out, indent=1))
    print("\nRESULT " + json.dumps({
        "nDays": n_total, "winnerMatch": n_match,
        "synOverDays": n_syn_over, "synCoveredDays": n_syn_days,
    }))

if __name__ == "__main__":
    main()
