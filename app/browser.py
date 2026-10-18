"""The board's pipeline steps for the in-browser board, run by Pyodide in web/worker.js.

The browser does the I/O (stores everything in IndexedDB, asks the decision model that runs in the page); this module
does the logic with the same code the server pipeline uses (sources, questions, scoring), so a job is fetched, asked
about and scored exactly the same way in both places. Everything in and out is plain JSON-able data.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from pathlib import Path
from typing import List, Optional

from . import questions as Q
from .profile import build_profile, carry_overrides, compact_candidate
from .scoring import heuristic_card, job_state, score_answers
from .settings import DEFAULT_SETTINGS
from .sources import OPT_IN_SOURCES, SOURCES, fetch_all
from .urls import norm_url

# These two sites don't send the header that lets a web page read them (CORS); the GitHub version still fetches them.
NO_CORS = {"himalayas", "workingnomads"}
BROWSER_SOURCES = [s for s in SOURCES if s not in NO_CORS and s not in OPT_IN_SOURCES]


def setup() -> None:
    """Make `requests` work in Pyodide (synchronous XHR from the worker), without the headers a browser won't let a
    page set (it refuses them and logs an error for every request)."""
    import pyodide_http
    import requests
    pyodide_http.patch_all()
    prepare = requests.Session.prepare_request

    def browser_safe(self, req):
        p = prepare(self, req)
        for h in ("Accept-Encoding", "Connection", "User-Agent"):
            p.headers.pop(h, None)
        return p
    requests.Session.prepare_request = browser_safe


def defaults() -> dict:
    return {**DEFAULT_SETTINGS, "sources": BROWSER_SOURCES, "max_deep": 150, "daily_at": "",
            "labels": {"field_labels": Q.FIELDS, "level_labels": Q.LEVELS, "countries": Q.COUNTRIES}}


def profile_from_resume(path: str, display_name: str = "", old: Optional[dict] = None) -> dict:
    """A profile from an uploaded resume (.tex, .pdf or text) without a decision engine: keywords, projects,
    header and country come from the text; the onboarding screen asks the person to confirm level and fields."""
    p = build_profile(Path(path), None, display_name or Path(path).name)
    return carry_overrides(old, p) if old else p


def search_terms(profile: dict) -> List[str]:
    return [t["name"] for t in profile.get("search_terms") or [] if t.get("keep")]


def fetch(settings: dict, terms: List[str], known: List[str], tracked_urls: List[str], log=print) -> dict:
    """New postings from the enabled sources that the browser can read, posted within max_age_days."""
    sources = [s for s in settings.get("sources") or BROWSER_SOURCES if s not in NO_CORS]
    jobs = fetch_all(sources, terms, settings.get("companies") or DEFAULT_SETTINGS["companies"], log)
    cutoff = (date.today() - timedelta(days=settings.get("max_age_days", 45))).isoformat()
    seen, tracked = set(known), {norm_url(u) for u in tracked_urls if u}
    fresh = [j for j in jobs if j["id"] not in seen and (not j.get("posted_at") or j["posted_at"] >= cutoff)]
    already = [j["id"] for j in fresh if norm_url(j.get("url") or "") in tracked]
    return {"fetched": len(jobs), "fresh": fresh, "already_tracked": already}


def triage_batches(jobs: List[dict], profile: dict) -> List[dict]:
    """The title-triage requests for these postings: [{ids, state, questions}]."""
    cand = compact_candidate(profile)
    state = {"candidate": {k: cand[k] for k in ("headline", "goal", "level", "fields")}}
    out = []
    for i in range(0, len(jobs), Q.TRIAGE_BATCH):
        batch = jobs[i:i + Q.TRIAGE_BATCH]
        out.append({"ids": [j["id"] for j in batch], "state": state, "questions": Q.triage_questions(batch)})
    return out


def triage_result(answers: dict, ids: List[str]) -> List[dict]:
    """Which titles go on to a full read, and why the others don't (same thresholds as the server)."""
    out = []
    for i, jid in enumerate(ids):
        field, above = answers[f"field_{i}"]["noul"], answers[f"above_{i}"]["noul"]
        ok = field >= Q.TRIAGE_FIELD_MIN and above <= Q.TRIAGE_ABOVE_MAX
        out.append({"id": jid, "field": field, "above": above, "ok": ok, "priority": field - 0.5 * above,
                    "reason": None if ok else ("off-field title" if field < Q.TRIAGE_FIELD_MIN else "title above level")})
    return out


MAX_SKILLS, MAX_GAPS = 10, 8      # keeps a full read to one model pass (≤ 32 questions)


def eval_request(job: dict, profile: dict) -> dict:
    """The full-read request for one posting: {state, questions, skills, gaps}. Asks about your top skills, and about a
    skill you don't list only when the posting names it (the model then judges whether it's actually required)."""
    skills = [k["name"] for k in profile.get("keywords") or [] if k.get("keep")][:MAX_SKILLS]
    cand = {**compact_candidate(profile), "skills": skills}       # has_<i> questions are numbered from this list
    text = f"{job.get('title', '')} {job.get('description', '')}".lower()
    named = lambda s: re.search(r"(?<![a-z0-9])" + re.escape(s.lower()) + r"(?![a-z0-9])", text)
    gaps = [g for g in Q.gap_vocab(skills) if named(g)][:MAX_GAPS]
    return {"state": {"candidate": cand, "job": job_state(job)}, "questions": Q.evaluate_questions(cand, gaps),
            "skills": skills, "gaps": gaps}


def card(job: dict, answers: Optional[dict], profile: dict, skills: List[str], gaps: List[str],
         min_match: float) -> dict:
    """The board card for one evaluated posting (or the keyword fallback when there are no answers)."""
    if not answers:
        return heuristic_card(job, profile, skills, min_match)
    c = score_answers(answers, profile, skills, gaps, min_match, job)
    return {**c, "scored_by": "laya-jobs"}


def board_row(job: dict, card_: dict, answers: Optional[dict], skills: List[str], gaps: List[str]) -> dict:
    """One job as the board stores it (the same fields app/state.py export_board writes for the GitHub version)."""
    d = {**job, "description": (job.get("description") or "")[:9000]}
    return {**d, "status": "filtered" if card_["gates"] else "new", "match": card_["match"], "card": card_,
            "reason": "; ".join(card_["gates"]) or None,
            "eval": {"answers": answers, "skills": skills, "gaps": gaps} if answers else None}


def rescore(rows: List[dict], profile: dict, min_match: float) -> List[dict]:
    """Re-score stored rows after a settings or profile change, without asking the model again."""
    out = []
    for r in rows:
        ev = r.get("eval")
        if ev:
            c = card(r, ev["answers"], profile, ev["skills"], ev["gaps"], min_match)
        else:
            skills = [k["name"] for k in profile.get("keywords") or [] if k.get("keep")]
            c = heuristic_card(r, profile, skills, min_match)
        keep = r.get("status") in ("later", "rejected", "applied")
        out.append({**r, "card": c, "match": c["match"], "reason": "; ".join(c["gates"]) or None,
                    "status": r["status"] if keep else ("filtered" if c["gates"] else "new")})
    return out


def as_json(x):
    """Pyodide hands JS objects in as JsProxy; turn them into plain Python data (and leave Python data alone)."""
    return x.to_py() if hasattr(x, "to_py") else x


