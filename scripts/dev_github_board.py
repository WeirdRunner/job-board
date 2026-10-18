"""A GitHub-synced board for checking the web app by hand: a local fake GitHub (tests/fake_github.py) holding an
encrypted test board — keys.json (passphrase "orbit tulip canyon ember velvet"), user.enc and board.enc.

    ../.venv/bin/python scripts/dev_github_board.py 8790
    then open the site with ?gh_api=http://127.0.0.1:8790&owner=me&repo=job-board and unlock with the passphrase.
    GET http://127.0.0.1:8790/_state shows what the page wrote back.
"""
import json
import sys
from pathlib import Path

import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import browser as B  # noqa: E402
from app import questions as Q  # noqa: E402
from app import vault  # noqa: E402
from tests import fake_github as fg  # noqa: E402
from tests.test_browser import _answers  # noqa: E402

PHRASE = "orbit tulip canyon ember velvet"


def board(profile):
    s = json.loads((ROOT / "bench/set.json").read_text())
    jobs = []
    for j in s["jobs"][:12]:
        job = {**j["state"], "id": j["id"], "url": f"https://example.com/{j['id']}", "source": "greenhouse",
               "posted_at": "2026-10-10"}
        r = B.eval_request(job, profile)
        c = B.card(job, _answers(r["questions"]), profile, r["skills"], r["gaps"], 0)
        jobs.append({**job, "status": "new", "match": c["match"], "card": c, "reason": None})
    return {"schema": 1, "exported_at": "2026-10-18T00:00:00", "jobs": jobs, "counts": {"new": len(jobs)},
            "last_run": None, "last_log": [], "kaggle": [], "engine": "Kev-4B",
            "defaults": {k: v for k, v in B.defaults().items() if k not in ("companies", "labels")},
            "labels": {"field_labels": Q.FIELDS, "level_labels": Q.LEVELS, "countries": Q.COUNTRIES}}


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    key = vault.new_data_key()
    profile = B.profile_from_resume(str(ROOT / "tests/fixtures/resume.tex"))
    user = {"schema": 1, "exported_at": "2026-10-18T00:00:00", "meta": {"profile": "2026-10-18T00:00:00"},
            "profile": profile, "settings": {}, "decisions": {}, "deleted_apps": {}, "kaggle": [], "resume": None,
            "photo": None, "applications": [{"uid": "u1", "company": "Acme", "role": "AI Engineer",
                                             "url": "https://example.com/acme", "status": "Applied",
                                             "applied_on": "2026-10-01", "created_at": "2026-10-01T00:00:00",
                                             "updated_at": "2026-10-01T00:00:00"}]}
    fg.reset()
    fg.seed({"keys.json": json.dumps({"wraps": [vault.wrap_passphrase(key, PHRASE, iterations=1000)]}),
             "user.enc": vault.encrypt(key, "user", user), "board.enc": vault.encrypt(key, "board", board(profile))})
    print(f"fake GitHub with a test board on :{port} — passphrase: {PHRASE}", flush=True)
    uvicorn.run(fg.app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
