#!/usr/bin/env python3
"""scripts/research/cost_model — the CANONICAL Python cost model for research backtests.

WHY THIS EXISTS (2026-07-09 project review): every research script was re-deciding its own
mid->executable haircut (flat +1c, floors, ad-hoc multipliers), so ROI numbers were not comparable
across studies and each new script re-risked trap #1/#8 (mid-basis pricing). The TypeScript source
of truth is `packages/core/src/sim/history-replay-ingest.ts` — `CALIBRATED_BOOK`, a piecewise-by-mid
spread + depth model FIT FROM THE REAL `opening_captures` books (median execAsk-mid, mid-execBid,
walked depthUsd by mid band; regenerate with `scripts/research/calibrate-history-spread.ts`).

ZERO-DRIFT RULE: this module does NOT embed a copy of the knots. It PARSES the committed literal out
of the TS file at import time and fails LOUD if the block is missing or malformed. If the TS model is
refit, every Python consumer picks it up on the next run automatically.

API (mirrors synthBook / fees.ts):
    exec_ask(mid, spread_mult=1.0) -> float   # the executable BUY price for a given archive mid
    exec_bid(mid, spread_mult=1.0) -> float   # the executable SELL price
    depth_usd(mid)                 -> float   # ~walked depth at that mid (the fillability axis)
    synth_quote(mid, spread_mult)  -> dict|None  # full SynthQuote mirror (None = no real quote)
    taker_fee_per_share(p, rate)   -> float   # fees.ts docs-verbatim: rate * p * (1 - p)

Usage in a research script (replaces the ad-hoc flat spread):
    import cost_model as cm
    ask = cm.exec_ask(mid)                      # instead of mid + 0.01 floored at 0.03
    fillable = cm.depth_usd(mid) >= stake_usd   # can the order even fill at this size?

Run `python scripts/research/cost_model.py` to selftest + print the parsed knots.
"""
from __future__ import annotations

import math
import re
import sys
from pathlib import Path

_TS_SOURCE = Path(__file__).resolve().parents[2] / "packages" / "core" / "src" / "sim" / "history-replay-ingest.ts"

_KNOT_RE = re.compile(
    r"\{\s*mid:\s*([0-9.]+)\s*,\s*askOver:\s*([0-9.]+)\s*,\s*bidOver:\s*([0-9.]+)\s*,\s*depthUsd:\s*([0-9.]+)\s*\}"
)


def _load_knots() -> list[dict]:
    """Parse CALIBRATED_BOOK out of the committed TS literal. Fails loud on any structural surprise."""
    try:
        text = _TS_SOURCE.read_text(encoding="utf-8")
    except OSError as e:  # pragma: no cover
        raise RuntimeError(f"cost_model: cannot read the TS source of truth at {_TS_SOURCE}: {e}") from e
    m = re.search(r"export const CALIBRATED_BOOK: BookModel = \[(.*?)\];", text, re.DOTALL)
    if not m:
        raise RuntimeError(f"cost_model: CALIBRATED_BOOK literal not found in {_TS_SOURCE} — was it renamed? Re-sync this parser.")
    knots = [
        {"mid": float(a), "ask_over": float(b), "bid_over": float(c), "depth_usd": float(d)}
        for a, b, c, d in _KNOT_RE.findall(m.group(1))
    ]
    if len(knots) < 3:
        raise RuntimeError(f"cost_model: parsed only {len(knots)} knots from CALIBRATED_BOOK — parser/format drift, refusing to run.")
    mids = [k["mid"] for k in knots]
    if mids != sorted(mids) or len(set(mids)) != len(mids):
        raise RuntimeError("cost_model: CALIBRATED_BOOK mids are not strictly increasing — refusing to run.")
    for k in knots:
        if not all(math.isfinite(v) and v >= 0 for v in k.values()):
            raise RuntimeError(f"cost_model: non-finite/negative knot {k} — refusing to run.")
    return knots


KNOTS: list[dict] = _load_knots()


def _interp(mid: float, field: str) -> float:
    """history-replay-ingest.ts `interp` mirror: linear between knots, nearest knot held flat outside."""
    ks = KNOTS
    if mid <= ks[0]["mid"]:
        return ks[0][field]
    if mid >= ks[-1]["mid"]:
        return ks[-1][field]
    for i in range(1, len(ks)):
        a, b = ks[i - 1], ks[i]
        if mid <= b["mid"]:
            w = (mid - a["mid"]) / (b["mid"] - a["mid"])
            return a[field] + w * (b[field] - a[field])
    return ks[-1][field]  # pragma: no cover


def ask_over(mid: float) -> float:
    return _interp(mid, "ask_over")


def bid_over(mid: float) -> float:
    return _interp(mid, "bid_over")


def depth_usd(mid: float) -> float:
    return max(0.0, _interp(mid, "depth_usd"))


def exec_ask(mid: float, spread_mult: float = 1.0) -> float:
    """The executable BUY price at this mid (synthBook execAsk mirror; capped at 0.999)."""
    return min(0.999, mid + ask_over(mid) * max(0.0, spread_mult))


def exec_bid(mid: float, spread_mult: float = 1.0) -> float:
    """The executable SELL price at this mid (synthBook execBid mirror; clamped to [0, mid])."""
    return max(0.0, min(mid, mid - bid_over(mid) * max(0.0, spread_mult)))


def synth_quote(mid: float, spread_mult: float = 1.0) -> dict | None:
    """Full synthBook mirror. None for a non-finite / <=0 / >=1 mid (no real quote exists)."""
    if not (isinstance(mid, (int, float)) and math.isfinite(mid)) or mid <= 0 or mid >= 1:
        return None
    d = depth_usd(mid)
    return {
        "mid": float(mid),
        "exec_ask": exec_ask(mid, spread_mult),
        "exec_bid": exec_bid(mid, spread_mult),
        "depth_usd": d,
        "sellback_depth_usd": d,
    }


def taker_fee_per_share(p: float, rate: float = 0.05) -> float:
    """fees.ts docs-verbatim taker fee: rate * p * (1 - p). Worked example: (0.34, 0.05) = 0.01122."""
    return rate * p * (1.0 - p)


def selftest() -> None:
    k0, kN = KNOTS[0], KNOTS[-1]
    # exact-knot lookups reproduce the committed literal
    assert abs(ask_over(k0["mid"]) - k0["ask_over"]) < 1e-12
    assert abs(depth_usd(kN["mid"]) - kN["depth_usd"]) < 1e-12
    # held flat outside the modeled range
    assert abs(ask_over(k0["mid"] / 2) - k0["ask_over"]) < 1e-12
    assert abs(ask_over(0.99) - kN["ask_over"]) < 1e-12
    # linear between two adjacent knots (checked at the midpoint of the first segment)
    a, b = KNOTS[0], KNOTS[1]
    midpt = (a["mid"] + b["mid"]) / 2
    assert abs(ask_over(midpt) - (a["ask_over"] + b["ask_over"]) / 2) < 1e-12
    # exec prices clamp correctly
    assert exec_ask(0.998) <= 0.999
    assert exec_bid(0.005) >= 0.0
    assert synth_quote(float("nan")) is None and synth_quote(0) is None and synth_quote(1) is None
    q = synth_quote(0.12)
    assert q is not None and q["exec_ask"] > 0.12 > q["exec_bid"] and q["depth_usd"] > 0
    # fees.ts worked example
    assert abs(taker_fee_per_share(0.34, 0.05) - 0.01122) < 1e-9
    print("cost_model selftest OK", file=sys.stderr)


if __name__ == "__main__":
    selftest()
    print(f"parsed {len(KNOTS)} CALIBRATED_BOOK knots from {_TS_SOURCE.name}:")
    for k in KNOTS:
        print(f"  mid {k['mid']:.2f}  askOver {k['ask_over']:.4f}  bidOver {k['bid_over']:.4f}  depth ${k['depth_usd']:.0f}")
