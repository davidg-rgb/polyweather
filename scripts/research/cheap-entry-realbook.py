#!/usr/bin/env python3
"""
cheap-entry-realbook.py — test the operator's 2026-07-25 proposal on the REAL order book.

Proposal: buy our house-pick bucket EARLY (not the final hours), capped at a max price that gives >=3x
(sub ~33c), hold to resolution; "occasional buy" (low fire rate) is acceptable. Thesis: if our win rate
> the price we pay, the 3x payout is net positive.

This grades it on the opening-captures archive (the ONLY real bid/ask/depth we have — ~1 month, 5-min
cadence, the 4 live cities), so entry is the ACTUAL bestAsk a taker pays and cost stops being an assumption.
Three outputs:
  (1) real half-spread (bestAsk-mid) + full spread + depth by hours-to-close  [operator item (c)]
  (2) band x entry-window real-book sweep: n, fire-rate, win rate, mean ask, net return, day-clustered CI
  (3) the best cell's verdict + how many live days it'd take to power it.

Read-only: reads the local archive + winners JSON; writes only out/. No DB, no trades, no keys.
"""
import gzip, json, glob, os, re, sys, math
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(__file__), "out")
ARCHIVE = os.path.join(OUT, "opening-captures-archive")
WINNERS = os.path.join(OUT, "live-winners.json")
LIVE = {"ankara", "helsinki", "kuala-lumpur", "wellington"}
sys.path.insert(0, r"C:\Users\david\.claude\skills\betting-market-analytics\scripts")
from analytics import taker_fee_per_share

def parse_temp(label):
    m = re.search(r"-?\d+", str(label or ""))
    return int(m.group()) if m else None

def load_captures():
    wins = {k: v for k, v in json.load(open(WINNERS)).items()}
    rows = []
    for f in sorted(glob.glob(os.path.join(ARCHIVE, "part-*.ndjson.gz"))):
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            for line in fh:
                r = json.loads(line)
                city = r.get("city")
                if city not in LIVE:
                    continue
                td = r.get("target_date")
                key = f"{city}|{td}"
                if key not in wins:
                    continue
                res = r.get("resolves_at"); cap = r.get("captured_at")
                if not res or not cap:
                    continue
                htc = (pd.Timestamp(res) - pd.Timestamp(cap)).total_seconds() / 3600.0
                bks = r.get("buckets") or []
                # house argmax pick among quotable buckets
                best = None
                for b in bks:
                    hp = b.get("houseProb")
                    if hp is None:
                        continue
                    if best is None or hp > best.get("houseProb", -1):
                        best = b
                if best is None:
                    continue
                rows.append({
                    "city": city, "date": td, "key": key, "htc": htc,
                    "pick_temp": parse_temp(best.get("label")),
                    "winner_temp": wins[key],
                    "mid": best.get("mid"), "bestAsk": best.get("bestAsk"),
                    "bestBid": best.get("bestBid"), "depthUsd": best.get("depthUsd"),
                    # for the spread-by-horizon table: ALL cheap buckets this capture
                    "_bks": [(b.get("mid"), b.get("bestAsk"), b.get("bestBid"), b.get("depthUsd")) for b in bks],
                })
    return pd.DataFrame(rows), wins

def wilson(k, n, z=1.96):
    if n == 0: return (float("nan"), float("nan"))
    ph = k/n; den = 1+z*z/n; c=(ph+z*z/(2*n))/den; h=z*math.sqrt(ph*(1-ph)/n+z*z/(4*n*n))/den; return (c-h, c+h)

def net_return(won, ask):
    fee = taker_fee_per_share(ask, 0.05)
    return (won - ask - fee) / ask  # per $1 of entry cost

def main():
    df, wins = load_captures()
    print(f"loaded {len(df)} live-city captures · {df.key.nunique()} events · {df.date.nunique()} dates "
          f"({df.date.min()}..{df.date.max()})\n")

    # ---- (1) real spread + depth by hours-to-close, for CHEAP buckets (mid<=0.33) ----
    print("=== (1) REAL half-spread & depth by hours-to-close  (cheap buckets, mid<=0.33) ===")
    sp = []
    for _, r in df.iterrows():
        for mid, ask, bid, dep in r["_bks"]:
            if mid is None or ask is None or bid is None or mid > 0.33 or mid <= 0: continue
            sp.append((r.htc, ask-mid, ask-bid, dep if dep else 0.0))
    S = pd.DataFrame(sp, columns=["htc", "half", "full", "depth"])
    S["bin"] = pd.cut(S.htc, [0,2,6,12,18,24,36,60])
    for b, g in S.groupby("bin", observed=True):
        print(f"  htc {str(b):>10}  n={len(g):>5}  half-spread med={g.half.median()*100:4.1f}c "
              f"full med={g.full.median()*100:4.1f}c")
    # house-PICK depth (the bucket actually bought) — the relevant capacity number; the all-cheap median
    # above is dragged to ~$1 by dead sub-cent longshots that would never be picked.
    print("  -- house-PICK (<=0.33 ask) executable depth by hours-to-close --")
    P = df[(df.bestAsk.notna()) & (df.bestAsk <= 0.33)].copy()
    P["bin"] = pd.cut(P.htc, [0,12,18,24,36,60])
    for b, g in P.groupby("bin", observed=True):
        dep = g.depthUsd.fillna(0)
        print(f"  htc {str(b):>10}  n={len(g):>5}  pick-depth med=${dep.median():6.0f}  p75=${dep.quantile(.75):6.0f}  "
              f"%>=$5={100*(dep>=5).mean():4.0f}%  %>=$25={100*(dep>=25).mean():4.0f}%")

    # ---- (2) band x entry-window REAL-BOOK sweep ----
    print("\n=== (2) REAL-BOOK sweep: house-pick, enter at bestAsk<=cap, hold to resolution ===")
    n_events = df.key.nunique()
    windows = [(2,12),(12,18),(18,24),(24,36),(36,54)]
    bands = [(0.0,0.33),(0.10,0.33),(0.15,0.30),(0.15,0.25),(0.20,0.33),(0.0,0.20)]
    print(f"{'window':<9}{'band':<13}{'n':>4}{'fire%':>7}{'win%':>7}{'ask':>7}{'netRet':>9}  day-clustered 95% CI")
    rng = np.random.default_rng(7)
    results = []
    for lo, hi in windows:
        # one entry per event: the latest capture still >= lo hours out, within [lo,hi]
        picks = {}
        for _, r in df.iterrows():
            if not (lo <= r.htc <= hi): continue
            if r.bestAsk is None or r.pick_temp is None: continue
            k = r.key
            if k not in picks or r.htc < picks[k].htc:  # closest to `lo` (latest allowable)
                picks[k] = r
        base = pd.DataFrame([{"key":r.key,"city":r.city,"date":r.date,"ask":float(r.bestAsk),
                              "won":int(r.pick_temp==r.winner_temp),"depth":float(r.depthUsd or 0)} for r in picks.values()])
        for blo, bhi in bands:
            c = base[(base.ask>=blo)&(base.ask<=bhi)]
            n = len(c)
            if n == 0:
                print(f"[{lo:2d},{hi:2d}]  {blo:.2f}-{bhi:.2f}   0   —"); continue
            won=c.won.values; ask=c.ask.values
            wr=won.mean(); lo2,hi2=wilson(int(won.sum()),n)
            rets=(won-ask-np.array([taker_fee_per_share(a,0.05) for a in ask]))/ask
            mret=rets.mean()
            # day-cluster bootstrap (each event = one city-day = one cluster here)
            bs=[np.mean(rng.choice(rets,len(rets),replace=True)) for _ in range(3000)]
            ci=(np.percentile(bs,2.5),np.percentile(bs,97.5))
            fire=n/n_events*100
            results.append({"window":f"{lo}-{hi}","band":f"{blo}-{bhi}","n":n,"fire":fire,"win":wr,"ask":ask.mean(),"net":mret,"ci":ci})
            print(f"[{lo:2d},{hi:2d}]  {blo:.2f}-{bhi:.2f} {n:>4}{fire:>6.0f}%{wr*100:>6.0f}%{ask.mean()*100:>6.1f}c{mret*100:>+8.1f}%   [{ci[0]*100:+.0f}%, {ci[1]*100:+.0f}%]")

    # ---- (3) best cell ----
    print("\n=== (3) best real-book cell (by net return, n>=8) ===")
    ok=[r for r in results if r["n"]>=8]
    if ok:
        best=max(ok,key=lambda r:r["net"])
        print(f"  window {best['window']}h  band {best['band']}  n={best['n']} (fire {best['fire']:.0f}%/day)  "
              f"win {best['win']*100:.0f}%  ask {best['ask']*100:.1f}c  netRet {best['net']*100:+.1f}%  CI [{best['ci'][0]*100:+.0f}%,{best['ci'][1]*100:+.0f}%]")
        # power: at this fire rate, entries/day, and days to reach n=40 (the gate floor)
        per_day = best["n"]/df.date.nunique()
        print(f"  fires ~{per_day:.2f} entries/day → ~{40/per_day:.0f} live days to reach the n>=40 gate floor")
    json.dump(results, open(os.path.join(OUT,"cheap-entry-realbook.json"),"w"), default=float, indent=1)

if __name__ == "__main__":
    main()
