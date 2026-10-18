"""Run one System One engine over a frozen benchmark set and save its raw answers.

  ../.venv/bin/python bench/run.py --name d1-ultra --base-url https://openrouter.ai/api --model liquid/d1-ultra --key …
  ../.venv/bin/python bench/run.py --set v2 --name …        # benchmark v2 (six candidates; bench/v2/)

Uses the app's own questions (app/questions.py) and client (app/jev.py), so what is measured is exactly
what the job board would ask. By default only the 12 core evaluation questions + triage are asked
(the per-skill chip questions are skipped to keep slow local engines tractable); --full adds them.
"""
import argparse
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import questions as Q  # noqa: E402
from app.questions import gap_vocab  # noqa: E402

BENCH = Path(__file__).parent
SETS = {"v1": BENCH, "v2": BENCH / "v2"}


def candidate() -> dict:
    """A fixed candidate so every engine sees identical state (no engine-dependent profile step). Frozen in
    candidate.json (built from the resume as of 2026-09-24), so editing the resume doesn't move the benchmark."""
    return json.loads((BENCH / "candidate.json").read_text())


def plan(set_name: str = "v1", full: bool = False, limit: int = 0):
    """What an engine is asked, exactly as the board asks it: (triage requests, evaluation requests).
    triage: [(state, questions, [title ids])]   eval: [(job id, state, questions)]"""
    s = json.loads((SETS[set_name] / "set.json").read_text())
    if set_name == "v1":
        c = candidate()
        cands = {None: c}
        for j in s["jobs"]:
            j["candidate"] = None
        for t in s["titles"]:
            t["candidate"] = None
    else:
        cands = s["candidates"]
    jobs = s["jobs"][: limit or None]
    titles = s["titles"][: (limit * 3) or None]
    qsets = {}
    for name, c in cands.items():
        qs = Q.evaluate_questions(c, gap_vocab(c["skills"]))
        qsets[name] = qs if full else {k: v for k, v in qs.items() if not k.startswith(("has_", "gap_"))}
    triage = []
    for name, c in cands.items():
        mine = [t for t in titles if t["candidate"] == name]
        tstate = {"candidate": {k: c[k] for k in ("headline", "goal", "level", "fields")}}
        for i in range(0, len(mine), Q.TRIAGE_BATCH):
            batch = mine[i:i + Q.TRIAGE_BATCH]
            triage.append((tstate, Q.triage_questions(batch), [t["id"] for t in batch]))
    evals = [(j["id"], {"candidate": cands[j["candidate"]], "job": j["state"]}, qsets[j["candidate"]]) for j in jobs]
    return triage, evals


def results_dir(set_name: str) -> Path:
    d = SETS[set_name] / "results"
    d.mkdir(exist_ok=True)
    return d


def run(name: str, ask, set_name="v1", full=False, limit=0, resume=False, meta=None, on_error="record"):
    """Ask every request in the plan with `ask(state, questions) -> answers`; checkpoint to results/<name>.json."""
    triage, evals = plan(set_name, full, limit)
    out = {"name": name, "set": set_name, "full": full, **(meta or {}),
           "jobs": {}, "titles": {}, "timing": {"eval": [], "triage": []}, "errors": []}
    if set_name == "v1":
        out["candidate"] = candidate()
    res_path = results_dir(set_name) / f"{name}.json"
    if resume and res_path.exists():
        prev = json.loads(res_path.read_text())
        for k in ("jobs", "titles", "timing"):
            out[k] = prev[k]
        print(f"resuming: {len(out['jobs'])} jobs, {len(out['titles'])} titles already done", flush=True)

    for n, (state, qs, ids) in enumerate(triage, 1):
        if all(i in out["titles"] for i in ids):
            continue
        t0 = time.time()
        try:
            ans = ask(state, qs)
        except Exception as e:
            out["errors"].append(f"triage {n}: {e}")
            print(f"triage {n}: ERROR {e}", flush=True)
            continue
        out["timing"]["triage"].append(time.time() - t0)
        for k, i in enumerate(ids):
            out["titles"][i] = {"field": ans[f"field_{k}"]["noul"], "above": ans[f"above_{k}"]["noul"]}
        print(f"triage {n}/{len(triage)}  {out['timing']['triage'][-1]:.1f}s", flush=True)

    for n, (jid, state, qs) in enumerate(evals, 1):
        if jid in out["jobs"]:
            continue
        t0 = time.time()
        try:
            ans = ask(state, qs)
        except Exception as e:
            out["errors"].append(f"{jid}: {e}")
            print(f"job {n}: ERROR {e}", flush=True)
            continue
        dt = time.time() - t0
        out["timing"]["eval"].append(dt)
        out["jobs"][jid] = ans
        print(f"job {n}/{len(evals)}  {dt:.1f}s  {state['job']['title'][:60]}", flush=True)
        if not limit:
            res_path.write_text(json.dumps(out))  # checkpoint

    ev = out["timing"]["eval"]
    if ev:
        print(f"median eval {statistics.median(ev):.2f}s")
    if not limit:
        res_path.write_text(json.dumps(out))
    return out


def main():
    from app import jev as jev_mod
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", default="jev-latest")
    ap.add_argument("--key", default="local")
    ap.add_argument("--set", default="v1", choices=list(SETS))
    ap.add_argument("--full", action="store_true", help="also ask the per-skill has_/gap_ questions")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--resume", action="store_true", help="keep answers already in results/<name>.json")
    args = ap.parse_args()

    jev_mod.API_URL = args.base_url.rstrip("/") + "/v1/systemone"
    client = jev_mod.Jev(api_key=args.key, model=args.model, timeout=1800)
    run(args.name, client.ask, args.set, args.full, args.limit, args.resume,
        meta={"model": args.model, "base_url": args.base_url})


if __name__ == "__main__":
    main()
