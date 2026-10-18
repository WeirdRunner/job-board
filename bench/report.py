"""Score every results/*.json against gold.json and print a comparison table.

  ../.venv/bin/python bench/report.py            # markdown table to stdout, also results/report.md
  ../.venv/bin/python bench/report.py --set v2   # benchmark v2 (six candidates): bench/v2/results/report.md
"""
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import questions as Q  # noqa: E402
from app.pipeline import score_answers  # noqa: E402

BENCH = Path(__file__).parent
CHOICES = ["field", "level", "experience", "work_mode", "employment", "degree"]


def acc(pairs):
    pairs = list(pairs)
    return (sum(a == b for a, b in pairs) / len(pairs), len(pairs)) if pairs else (None, 0)


def brier(pairs):
    pairs = list(pairs)
    return sum((p - float(y)) ** 2 for p, y in pairs) / len(pairs) if pairs else None


def ece(conf_correct, bins=10):
    if not conf_correct:
        return None
    total, err = len(conf_correct), 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        cell = [(c, k) for c, k in conf_correct if lo <= c < hi or (b == bins - 1 and c == 1.0)]
        if cell:
            err += len(cell) / total * abs(sum(c for c, _ in cell) / len(cell) - sum(k for _, k in cell) / len(cell))
    return err


def evaluate(res, gold, cands=None, states=None):
    r = {"name": res["name"]}
    G, A = gold["jobs"], res["jobs"]
    ids = [i for i in G if i in A]
    r["jobs_answered"] = f"{len(ids)}/{len(G)}"
    r["tech_acc"], _ = acc((A[i]["tech_role"]["noul"] >= 0.5, G[i]["tech"]) for i in ids if "tech" in G[i])
    r["tech_brier"] = brier((A[i]["tech_role"]["noul"], G[i]["tech"]) for i in ids if "tech" in G[i])
    r["eligible_acc"], _ = acc((A[i]["location"]["choice"] in ("remote_open", "local_office"), G[i]["eligible"])
                               for i in ids if "eligible" in G[i])
    r["location_acc"], _ = acc((A[i]["location"]["choice"], G[i]["location"]) for i in ids if "location" in G[i])
    cc = []
    for c in CHOICES:
        key = {"field": "field", "level": "level", "experience": "experience", "work_mode": "work_mode",
               "employment": "employment", "degree": "degree"}[c]
        pairs = [(A[i][key]["choice"], G[i][c]) for i in ids if c in G[i]]
        r[f"{c}_acc"], r[f"{c}_n"] = acc(pairs)
        cc += [(A[i][key]["confidence"], A[i][key]["choice"] == G[i][c]) for i in ids if c in G[i]]
    cc += [(A[i]["location"]["confidence"], A[i]["location"]["choice"] == G[i]["location"]) for i in ids if "location" in G[i]]
    r["choice_ece"] = ece(cc)
    r["red_flag_acc"], _ = acc((A[i]["red_flags"]["noul"] >= 0.5, G[i]["red_flags"]) for i in ids if "red_flags" in G[i])
    sk = [(A[i]["skill_alignment"]["score"], G[i]["skill"]) for i in ids if "skill" in G[i]]
    r["skill_mae"] = sum(abs(a - b) for a, b in sk) / len(sk) if sk else None

    # The number that matters: which jobs would reach the board (pipeline scoring, default threshold).
    tp = fp = fn = tn = 0
    for i in ids:
        if G[i].get("relevant") is None:
            continue
        c = (cands or {}).get(i.split(":", 1)[0]) if cands else None
        prof = ({"level": c["level"], "country": c["country"], "languages": c.get("languages")} if c
                else {"level": "entry", "country": "India"})
        card = score_answers(A[i], prof, [], [], Q.DEFAULT_MIN_MATCH, (states or {}).get(i))
        shown = not card["gates"]
        tp += shown and G[i]["relevant"]
        fp += shown and not G[i]["relevant"]
        fn += (not shown) and G[i]["relevant"]
        tn += (not shown) and not G[i]["relevant"]
    r["board"] = f"TP {tp} · FP {fp} · FN {fn} · TN {tn}"
    r["board_correct"] = (tp + tn) / max(1, tp + fp + fn + tn)
    r["board_precision"] = tp / (tp + fp) if tp + fp else None
    r["board_recall"] = tp / (tp + fn) if tp + fn else None
    r["board_f1"] = 2 * tp / (2 * tp + fp + fn) if tp else 0.0

    GT, AT = gold["titles"], res["titles"]
    tid = [i for i in GT if i in AT]
    r["triage_field_acc"], _ = acc((AT[i]["field"] >= 0.5, GT[i]["field"]) for i in tid if "field" in GT[i])
    r["triage_above_acc"], _ = acc((AT[i]["above"] >= 0.5, GT[i]["above"]) for i in tid if "above" in GT[i])
    r["triage_field_brier"] = brier((AT[i]["field"], GT[i]["field"]) for i in tid if "field" in GT[i])
    # Triage as used: would it wrongly drop a good title? (recall on in-field, not-above titles)
    keep = [(AT[i]["field"] >= Q.TRIAGE_FIELD_MIN and AT[i]["above"] <= Q.TRIAGE_ABOVE_MAX)
            for i in tid if GT[i].get("field") and GT[i].get("above") is False]
    r["triage_keep_recall"] = sum(keep) / len(keep) if keep else None

    ev, tr = res["timing"]["eval"], res["timing"]["triage"]
    r["sec_per_job"] = statistics.median(ev) if ev else None
    r["sec_per_60_titles"] = statistics.median(tr) if tr else None
    r["errors"] = len(res["errors"])
    return r


def fmt(v):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


def gold_v2():
    """Merge the hand labels (bench/v2/labels/*.json) into one gold dict."""
    g = {"jobs": {}, "titles": {}}
    for f in sorted((BENCH / "v2" / "labels").glob("*.json")):
        d = json.loads(f.read_text())
        for i, x in d["jobs"].items():
            g["jobs"][i] = {"tech": x.get("tech"), "field": x.get("field"), "level": x.get("level"),
                            "location": x.get("location"), "eligible": x.get("eligible"),
                            "experience": x.get("experience"), "work_mode": x.get("work_mode"),
                            "employment": x.get("employment"), "degree": x.get("degree"),
                            "red_flags": x.get("red_flags"), "relevant": x.get("relevant"), "skill": x.get("skill")}
            g["jobs"][i] = {k: v for k, v in g["jobs"][i].items() if v is not None}
        for i, x in d["titles"].items():
            g["titles"][i] = {k: v for k, v in x.items() if v is not None}
    return g


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="v1", choices=["v1", "v2"])
    ap.add_argument("--group", help="v2 only: score just the candidates whose name starts with this (owner, train, heldout)")
    args = ap.parse_args()
    base = BENCH if args.set == "v1" else BENCH / "v2"
    cands = states = None
    if args.set == "v1":
        gold = json.loads((BENCH / "gold.json").read_text())
    else:
        gold = gold_v2()
        sv = json.loads((base / "set.json").read_text())
        cands, states = sv["candidates"], {j["id"]: j["state"] for j in sv["jobs"]}
        if args.group:
            gold = {k: {i: x for i, x in v.items() if i.startswith(args.group)} for k, v in gold.items()}
    rows = [evaluate(json.loads(p.read_text()), gold, cands, states) for p in sorted((base / "results").glob("*.json"))]
    if not rows:
        print("no results yet")
        return
    keys = ["jobs_answered", "board", "board_f1", "board_precision", "board_recall", "board_correct", "tech_acc",
            "tech_brier", "eligible_acc", "location_acc",
            "level_acc", "experience_acc", "work_mode_acc", "field_acc", "employment_acc", "degree_acc",
            "red_flag_acc", "skill_mae", "choice_ece", "triage_field_acc", "triage_above_acc",
            "triage_field_brier", "triage_keep_recall", "sec_per_job", "sec_per_60_titles", "errors"]
    lines = ["| metric | " + " | ".join(r["name"] for r in rows) + " |", "|---|" + "---|" * len(rows)]
    lines += [f"| {k} | " + " | ".join(fmt(r.get(k)) for r in rows) + " |" for k in keys]
    md = "\n".join(lines)
    print(md)
    (base / "results" / f"report{'-' + args.group if args.group else ''}.md").write_text(md + "\n")


if __name__ == "__main__":
    main()
