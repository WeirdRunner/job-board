"""app/browser.py: the pipeline steps the in-browser board runs in Pyodide (web/worker.js)."""
import json
import sys
from pathlib import Path

from app import browser as B
from app import questions as Q

RESUME = Path(__file__).resolve().parent / "fixtures" / "resume.tex"
BENCH = Path(__file__).resolve().parents[1] / "bench"


def _jobs(n=3):
    s = json.loads((BENCH / "set.json").read_text())
    return [{**j["state"], "id": j["id"], "url": f"https://example.com/{j['id']}"} for j in s["jobs"][:n]]


def _answers(questions):
    """Synthetic engine answers in the /v1/systemone shape: the first option most likely, every option possible."""
    out = {}
    for qid, q in questions.items():
        if q["type"] == "noul":
            out[qid] = {"type": "noul", "noul": 0.8}
            continue
        keys = [str(i) for i in range(len(q["criteria"]))] if q["type"] == "score" else list(q["criteria"])
        probs = {k: (0.6 if i == 0 else 0.4 / (len(keys) - 1)) for i, k in enumerate(keys)}
        a = {"type": q["type"], "confidence": 0.6, "probabilities": probs}
        if q["type"] == "score":
            a["score"] = sum(int(k) * v for k, v in probs.items())
            a["legend"] = {k: str(x) for k, x in zip(keys, q["criteria"])}
        else:
            a["choice"] = keys[0]
        out[qid] = a
    return out


def test_light_imports():
    """What the browser loads must not pull in the server's database, Kaggle or Jev client (checked in a fresh process)."""
    import subprocess
    code = ("import sys, app.browser, app.scoring, app.questions; "
            "print(sorted(m for m in ('app.db', 'app.kaggle', 'app.jev', 'app.pipeline') if m in sys.modules))")
    out = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1],
                         capture_output=True, text=True, check=True).stdout.strip()
    assert out == "[]", out


def test_profile_and_requests():
    p = B.profile_from_resume(str(RESUME))
    assert p["country"] == "India" and p["keywords"] and B.search_terms(p)
    jobs = _jobs()
    t = B.triage_batches(jobs, p)
    assert t[0]["ids"] == [j["id"] for j in jobs] and len(t[0]["questions"]) == 2 * len(jobs)
    r = B.eval_request(jobs[0], p)
    assert len(r["skills"]) <= B.MAX_SKILLS and len(r["gaps"]) <= B.MAX_GAPS
    assert len(r["questions"]) <= 32                                          # one model pass
    assert [k for k in r["questions"] if k.startswith("has_")] == [f"has_{i}" for i in range(len(r["skills"]))]
    text = (jobs[0]["title"] + jobs[0]["description"]).lower()
    assert all(g.lower() in text for g in r["gaps"])                          # only skills the posting names


def test_triage_and_card():
    ids = ["a", "b", "c"]
    ans = {"field_0": {"noul": 0.9}, "above_0": {"noul": 0.1}, "field_1": {"noul": 0.1}, "above_1": {"noul": 0.1},
           "field_2": {"noul": 0.9}, "above_2": {"noul": 0.95}}
    res = B.triage_result(ans, ids)
    assert [r["ok"] for r in res] == [True, False, False]
    assert res[1]["reason"] == "off-field title" and res[2]["reason"] == "title above level"
    p = B.profile_from_resume(str(RESUME))
    job = _jobs(1)[0]
    r = B.eval_request(job, p)
    real = _answers(r["questions"])
    c = B.card(job, real, p, r["skills"], r["gaps"], Q.DEFAULT_MIN_MATCH)
    assert c["scored_by"] == "laya-jobs" and 0 <= c["match"] <= 100
    row = B.board_row(job, c, real, r["skills"], r["gaps"])
    assert row["status"] == ("filtered" if c["gates"] else "new") and row["eval"]["answers"] is real
    again = B.rescore([{**row, "status": "later"}], p, 0)
    assert again[0]["status"] == "later"                                      # your own decisions are kept
    assert B.card(job, None, p, r["skills"], [], 40)["scored_by"] == "heuristic"


def test_defaults_are_browser_sources():
    d = B.defaults()
    assert not set(d["sources"]) & B.NO_CORS and d["labels"]["field_labels"] == Q.FIELDS
