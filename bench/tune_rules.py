"""Choose the board's gate thresholds honestly: leave-one-candidate-out over benchmark v2 (+ v1 as the owner's second
group). For each held-out candidate, thresholds are picked on the other groups and scored on the held-out one, so the
reported F1 is never measured on data the thresholds were tuned on.

    ../.venv/bin/python bench/tune_rules.py jev laya-jobs-cpu4 …     # engines = result names in bench/v2/results
"""
import itertools
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
from app import questions as Q  # noqa: E402
from app.pipeline import score_answers  # noqa: E402
from report import gold_v2  # noqa: E402

GRID = {"min_match": [30, 35, 40, 45], "GATE_SKILL_MIN": [0.0, 1.0, 1.25, 1.5, 1.75],
        "GATE_LOCATION_ELIGIBLE_MIN": [0.4, 0.5, 0.6, 0.7]}


def items(engine):
    """[(group, shown_fn_inputs, relevant)] for every gold-labelled job the engine answered."""
    out = []
    g2 = gold_v2()["jobs"]
    sv = json.loads((ROOT / "bench/v2/set.json").read_text())
    states = {j["id"]: j["state"] for j in sv["jobs"]}
    p2 = ROOT / "bench/v2/results" / f"{engine}.json"
    if p2.exists():
        A = json.loads(p2.read_text())["jobs"]
        for i, g in g2.items():
            if g.get("relevant") is not None and i in A:
                c = sv["candidates"][i.split(":")[0]]
                out.append((i.split(":")[0], A[i], {"level": c["level"], "country": c["country"],
                                                     "languages": c.get("languages")}, states[i], g["relevant"]))
    p1 = ROOT / "bench/results" / f"{engine}.json"
    if p1.exists():
        g1 = json.loads((ROOT / "bench/gold.json").read_text())["jobs"]
        s1 = {j["id"]: j["state"] for j in json.loads((ROOT / "bench/set.json").read_text())["jobs"]}
        A = json.loads(p1.read_text())["jobs"]
        for i, g in g1.items():
            if g.get("relevant") is not None and i in A:
                out.append(("owner_v1", A[i], {"level": "entry", "country": "India"}, s1[i], g["relevant"]))
    return out


def f1(rows, params):
    for k, v in params.items():
        if k != "min_match":
            setattr(Q, k, v)
    tp = fp = fn = 0
    for _, a, prof, st, rel in rows:
        shown = not score_answers(a, prof, [], [], params["min_match"], st)["gates"]
        tp += shown and rel
        fp += shown and not rel
        fn += (not shown) and rel
    return 2 * tp / (2 * tp + fp + fn) if tp else 0.0, tp, fp, fn


def main():
    default = {"min_match": Q.DEFAULT_MIN_MATCH, "GATE_SKILL_MIN": Q.GATE_SKILL_MIN,
               "GATE_LOCATION_ELIGIBLE_MIN": Q.GATE_LOCATION_ELIGIBLE_MIN}
    combos = [dict(zip(GRID, v)) for v in itertools.product(*GRID.values())]
    for engine in sys.argv[1:]:
        rows = items(engine)
        groups = sorted({r[0] for r in rows})
        tp = fp = fn = 0
        picks = []
        for held in groups:
            train = [r for r in rows if r[0] != held]
            best = max(combos, key=lambda p: (f1(train, p)[0], p == default))
            picks.append(best)
            _, a, b, c = f1([r for r in rows if r[0] == held], best)
            tp, fp, fn = tp + a, fp + b, fn + c
        loco = 2 * tp / (2 * tp + fp + fn) if tp else 0.0
        d = f1(rows, default)
        allbest = max(combos, key=lambda p: f1(rows, p)[0])
        print(f"{engine:22} default F1 {d[0]:.2f} (TP {d[1]} FP {d[2]} FN {d[3]}) | held-out-tuned F1 {loco:.2f} "
              f"(TP {tp} FP {fp} FN {fn}) | rules chosen on all data: {allbest}")
        for k, v in default.items():
            if k != "min_match":
                setattr(Q, k, v)


if __name__ == "__main__":
    main()
