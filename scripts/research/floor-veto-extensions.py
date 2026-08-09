"""
floor-veto-extensions — can the armed (3°C/10h) floor veto be extended with MORE cost cutoffs?

Runs over the existing floor-veto panel (out/floor-veto/panel.csv — the real-book hourly replay,
5,856 entries / 839 events / 44 cities / 22 days). For each PRE-REGISTERED candidate cutoff we score:
  · the cutoff's own vetoed class (train + test, city-day clustered CI), and — the decisive number —
  · its INCREMENT beyond the armed (3,10) veto: the rows it catches that (3,10) does not.
    An extension only earns adoption if the increment itself is confidently negative.

SECOND-LOOK DISCIPLINE: the test split (07-17..27) was already used once to validate (3,10).
This is a re-use — only increments whose test CI sits WELL clear of 0 on BOTH clusterings
(city-day and day-block) count as supported; anything marginal = INSUFFICIENT, adjudicate forward.

Candidate families (fixed before looking — the whole grid is reported, nothing hidden):
  A gap×hour refinements:  (2,12) (2,14) (3,12) — single-config replacements/tightenings
  B the union (3,10)∪(2,12) — needs a code change (two-threshold veto)
  C overconfidence: housePro − ask ≥ δ at local ≥ H   δ∈{0.3,0.4,0.5} H∈{10,12}
  D late-hour blanket: ANY entry at local ≥ H         H∈{13,14,15}
  E expensive-late: ask ≥ a at local ≥ 12             a∈{0.30,0.35,0.40}
  F floor-bucket-late: gap == 0 at local ≥ 13 (the Wellington 07-28 class)

Run: python scripts/research/floor-veto-extensions.py
Out: out/floor-veto/EXTENSIONS.json (+ stdout report)
"""
from __future__ import annotations

import csv
import json
import os
import sys

sys.path.insert(0, r"C:\Users\david\.claude\skills\betting-market-analytics\scripts")
from analytics import clustered_ci

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "out", "floor-veto")
TRAIN_END = "2026-07-16"


def load_panel() -> list[dict]:
    rows = []
    with open(os.path.join(OUT, "panel.csv"), newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows.append({
                "city": r["city"], "day": r["day"], "cityday": r["cityday"],
                "local_hour": float(r["local_hour"]),
                "gap_c": float(r["gap_c"]) if r["gap_c"] else None,
                "floor_dead": r["floor_dead"] == "True",
                "won": r["won"] == "True",
                "ask": float(r["ask"]),
                "house_prob": float(r["house_prob"]) if r["house_prob"] else None,
                "net_return": float(r["net_return"]),
            })
    return rows


def base_veto(r: dict) -> bool:
    """The ARMED veto: floor-dead, or gap ≥3°C at local ≥10h."""
    return r["floor_dead"] or (r["gap_c"] is not None and r["gap_c"] >= 3.0 and r["local_hour"] >= 10)


CANDIDATES: list[tuple[str, str]] = []  # (family:name, description) — predicate registry below


def make_predicates():
    preds: dict[str, callable] = {}

    def reg(name, fn):
        preds[name] = fn

    for g, h in [(2.0, 12), (2.0, 14), (3.0, 12)]:
        reg(f"A gap>={g:g} hour>={h}",
            lambda r, g=g, h=h: r["floor_dead"] or (r["gap_c"] is not None and r["gap_c"] >= g and r["local_hour"] >= h))
    reg("B union (3,10)+(2,12)",
        lambda r: base_veto(r) or (r["gap_c"] is not None and r["gap_c"] >= 2.0 and r["local_hour"] >= 12))
    for d in (0.3, 0.4, 0.5):
        for h in (10, 12):
            reg(f"C overconf q-ask>={d:g} hour>={h}",
                lambda r, d=d, h=h: r["house_prob"] is not None and (r["house_prob"] - r["ask"]) >= d and r["local_hour"] >= h)
    for h in (13, 14, 15):
        reg(f"D any entry hour>={h}", lambda r, h=h: r["local_hour"] >= h)
    for a in (0.30, 0.35, 0.40):
        reg(f"E ask>={a:g} hour>=12", lambda r, a=a: r["ask"] >= a and r["local_hour"] >= 12)
    reg("F floor-bucket gap==0 hour>=13",
        lambda r: r["gap_c"] is not None and abs(r["gap_c"]) < 1e-9 and r["local_hour"] >= 13)
    return preds


def stats(sub: list[dict]) -> dict:
    if len(sub) < 2:
        return {"n": len(sub)}
    cd = clustered_ci(sub, key="cityday", value="net_return")
    db = clustered_ci(sub, key="day", value="net_return")
    return {"n": len(sub), "win": round(sum(r["won"] for r in sub) / len(sub), 3),
            "mean": round(cd["mean"], 3),
            "ciCD": [round(cd["ciLow"], 3), round(cd["ciHigh"], 3)],
            "ciDay": [round(db["ciLow"], 3), round(db["ciHigh"], 3)],
            "nClusters": cd["nClusters"]}


def main() -> None:
    panel = load_panel()
    train = [r for r in panel if r["day"] <= TRAIN_END]
    test = [r for r in panel if r["day"] > TRAIN_END]
    preds = make_predicates()

    report = []
    for name, fn in preds.items():
        row = {"cutoff": name}
        for split_name, rows in (("train", train), ("test", test)):
            vet = [r for r in rows if fn(r)]
            inc = [r for r in rows if fn(r) and not base_veto(r)]
            row[split_name] = {"vetoed": stats(vet), "incrementBeyondArmed": stats(inc)}
        # supported = the INCREMENT is confidently negative on test, both clusterings, and train agrees in sign
        ti = row["test"]["incrementBeyondArmed"]
        tr = row["train"]["incrementBeyondArmed"]
        row["supported"] = bool(
            ti.get("n", 0) >= 30 and ti.get("ciCD", [0, 1])[1] < 0 and ti.get("ciDay", [0, 1])[1] < 0
            and tr.get("n", 0) >= 10 and tr.get("mean", 0) < 0
        )
        report.append(row)

    with open(os.path.join(OUT, "EXTENSIONS.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)

    print(f"panel n={len(panel)}  train={len(train)}  test={len(test)}   "
          f"armed(3,10) test increment baseline: vetoed rows already handled\n")
    hdr = f"{'cutoff':34s} {'TR inc n':>8s} {'TR inc mean':>11s} {'TE inc n':>8s} {'TE inc mean':>11s} {'TE inc ciCD':>18s} {'TE inc ciDay':>18s} sup"
    print(hdr)
    for row in report:
        tr = row["train"]["incrementBeyondArmed"]
        te = row["test"]["incrementBeyondArmed"]
        fmt_ci = lambda s: f"[{s['ciCD'][0]:+.2f},{s['ciCD'][1]:+.2f}]" if "ciCD" in s else "—"
        fmt_cid = lambda s: f"[{s['ciDay'][0]:+.2f},{s['ciDay'][1]:+.2f}]" if "ciDay" in s else "—"
        print(f"{row['cutoff']:34s} {tr.get('n',0):8d} {tr.get('mean','—'):>11} "
              f"{te.get('n',0):8d} {te.get('mean','—'):>11} {fmt_ci(te):>18s} {fmt_cid(te):>18s} "
              f"{'✓' if row['supported'] else ''}")

    print("\nRESULT " + json.dumps([{"cutoff": r["cutoff"], "supported": r["supported"],
                                     "testInc": r["test"]["incrementBeyondArmed"]}
                                    for r in report if r["supported"]]))


if __name__ == "__main__":
    main()
