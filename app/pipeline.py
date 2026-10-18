"""The ETL pipeline: EXTRACT (sources) -> TRANSFORM (Jev triage + evaluation + scoring) -> LOAD (board).

Jev makes every semantic decision; code does the arithmetic, dates, dedupe and gating,
as TypeSafe recommends. Questions and thresholds live in questions.py.
"""
from __future__ import annotations

import threading
import traceback
from contextlib import nullcontext
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

from . import questions as Q
from .db import DB, now
from .jev import Jev, JevError
from .kaggle import KAGGLE_KEV_RUN, KEV_COMMIT, KaggleError, KaggleRunner
from .profile import compact_candidate
from .scoring import (CITIES, DEGREE_LABEL, DESC_CHARS, EMPLOYMENT_LABEL, EXPERIENCE_LABEL, LEVEL_LABEL,  # noqa: F401
                      MODE_LABEL, _tokens, gap_vocab, heuristic_card, job_state, kev_take, listed_location,
                      score_answers)
from .settings import DEFAULT_SETTINGS, LEGACY_SOURCES  # noqa: F401
from .sources import DEFAULT_COMPANIES, OPT_IN_SOURCES, SOURCES, fetch_all
from .urls import norm_url as _norm_url

KAGGLE_ONLY = "kaggle"        # engine "key" meaning: no hosted Jev — run decisions on Kaggle (scripts/ci_run.py)


# ---------------------------------------------------------------------------
# Pipeline runner
# ---------------------------------------------------------------------------

class Pipeline:
    def __init__(self, db: DB, jev: Jev, engine=None, kaggle: Optional[KaggleRunner] = None):
        self.db, self.jev, self.engine = db, jev, engine
        self.kaggle = kaggle or KaggleRunner(db, log=self.log)
        self.github_mode = lambda: False          # main.py: True while GitHub sync is on
        self.state = {"running": False, "stage": "idle", "done": 0, "total": 0, "log": [], "error": None}
        self._thread: Optional[threading.Thread] = None

    def settings(self) -> dict:
        saved = self.db.get("settings") or {}
        s = {**DEFAULT_SETTINGS, **saved}
        # Sources added in an update are switched on once for existing boards; one you then switch off stays off.
        seen = set(saved.get("sources_seen") or (LEGACY_SOURCES if "sources" in saved else SOURCES))
        s["sources"] = list(s["sources"]) + [x for x in SOURCES if x not in seen and x not in OPT_IN_SOURCES
                                             and x not in s["sources"]]
        s["sources_seen"] = list(SOURCES)
        # Company lists aren't edited in the UI: new defaults join whatever a board already had.
        mine = saved.get("companies") or {}
        s["companies"] = {k: list(dict.fromkeys(list(DEFAULT_COMPANIES.get(k, [])) + list(mine.get(k, []))))
                          for k in {*DEFAULT_COMPANIES, *mine}}
        return s

    # -- daily routine ------------------------------------------------------------
    def due(self, now) -> bool:
        """True when today's scheduled run hasn't happened yet and its time has passed."""
        at = (self.settings().get("daily_at") or "").strip()
        if not at or self.state["running"] or not self.db.get("profile") or self.github_mode():
            return False
        hh, mm = (int(x) for x in at.split(":"))
        if (now.hour, now.minute) < (hh, mm):
            return False
        last = self.db.last_run()
        if not last:
            return True
        # runs are stamped in UTC; compare calendar days in local time
        started = datetime.fromisoformat(last["started"][:19]) + (datetime.now() - datetime.utcnow())
        return started.date() < now.date()

    def start_scheduler(self, check_every: float = 300) -> None:
        def loop():
            from datetime import datetime
            import time as _t
            _t.sleep(60)                      # let the app finish starting before a catch-up run
            while True:
                try:
                    if self.due(datetime.now()):
                        self.log("Daily run (scheduled)")
                        self.start()
                except Exception:
                    traceback.print_exc()
                _t.sleep(check_every)
        threading.Thread(target=loop, daemon=True, name="daily-run").start()

    def _workers(self) -> int:
        # A local engine answers one request at a time; parallel requests would only queue (and time out).
        return 1 if self.jev.is_local else self.settings()["workers"]

    def log(self, msg: str) -> None:
        self.state["log"].append(f"{datetime.now():%H:%M:%S}  {msg}")    # local time for reading
        self.state["log"] = self.state["log"][-300:]

    def _stage(self, name: str, total: int = 0) -> None:
        self.state.update(stage=name, done=0, total=total)
        self.log(f"— {name}")

    def start(self, reevaluate: bool = False) -> bool:
        if self.state["running"]:
            return False
        self.state = {"running": True, "stage": "starting", "done": 0, "total": 0, "log": [], "error": None}
        self._thread = threading.Thread(target=self._run_safe, args=(reevaluate,), daemon=True)
        self._thread.start()
        return True

    def _run_safe(self, reevaluate: bool) -> None:
        started = now()
        stats: Dict[str, int] = {}
        try:
            stats = self.run(reevaluate)
        except Exception as e:
            self.state["error"] = str(e)
            self.log(f"✗ {e}")
            traceback.print_exc()
        finally:
            self.state.update(running=False, stage="done" if not self.state["error"] else "failed")
            self.db.save_run(started, {**stats, "jev": dict(self.jev.usage)}, self.state["log"])

    # -- the run ----------------------------------------------------------
    def run(self, reevaluate: bool = False, retriage: bool = False) -> Dict[str, int]:
        cfg = self.settings()
        profile = self.db.get("profile")
        if not profile:
            raise RuntimeError("No profile yet — upload or build your resume profile first.")
        use_jev = self.jev.available
        self.log(f"Decision engine {'ready' if use_jev else 'NOT configured — using heuristic fallback'}"
                 f"{' (local)' if self.jev.is_local else ''}")

        terms = [t["name"] for t in profile["search_terms"] if t["keep"]]
        self._stage(f"Extract: {len(cfg['sources'])} sources · terms: {', '.join(terms)}")
        stale = self.db.drop_stale("freelancer", hours=24)     # Freelancer.com's API terms: refresh within 24 h
        if stale:
            self.log(f"Removed {stale} Freelancer.com gigs older than a day (they're refetched if still open)")
        jobs = fetch_all(cfg["sources"], terms, cfg["companies"], self.log)
        cutoff = (date.today() - timedelta(days=cfg["max_age_days"])).isoformat()
        known = self.db.known_ids()
        fresh = [j for j in jobs if j["id"] not in known and (not j["posted_at"] or j["posted_at"] >= cutoff)]
        self.log(f"{len(jobs)} postings · {len(fresh)} new & posted within {cfg['max_age_days']} days")
        self.db.insert_raw(fresh)
        if retriage:          # a better engine arrived: give titles the old one turned away another look
            n = self.db.retriage([j for j in jobs if j["id"] in known and (not j["posted_at"] or j["posted_at"] >= cutoff)])
            self.log(f"{n} postings turned away at triage earlier get another look")
        refreshed = self.db.refresh_text([j for j in jobs if j["id"] in known])
        if refreshed:
            self.log(f"Updated the text of {refreshed} postings already on your board")
        # Postings already in the Tracker (e.g. applied elsewhere) skip triage and never reach the deck.
        tracked = {_norm_url(a["url"]) for a in self.db.applications() if a["url"]}
        already = [j for j in fresh if _norm_url(j["url"]) in tracked]
        for j in already:
            self.db.update_job(j["id"], status="applied", reason="already in Tracker")
        if already:
            self.log(f"{len(already)} postings already in your Tracker — skipped")

        skills = [k["name"] for k in profile["keywords"] if k["keep"]]
        candidate = compact_candidate(profile)
        raw = self.db.jobs(["raw"], limit=100_000)
        to_triage = [r["data"] for r in raw if not r["triage"]]

        args = (profile, candidate, skills, cfg)
        # 1. Hosted Jev (TypeSafe): fastest and most accurate (bench/results/report.md). Kev on Kaggle if it fails.
        if use_jev and not self.jev.is_local and self.jev.api_key != KAGGLE_ONLY:
            try:
                return self._run_local(to_triage, raw, profile, candidate, skills, cfg, terms, use_jev, reevaluate,
                                       len(jobs), len(fresh))
            except JevError as e:
                if not self.kaggle.configured:
                    raise
                self.log(f"Jev unavailable ({str(e)[:160]}) — falling back to Kev on Kaggle")
                raw = self.db.jobs(["raw"], limit=100_000)
                to_triage = [r["data"] for r in raw if not r["triage"]]
                return self._run_remote(to_triage, raw, *args, len(jobs), len(fresh))
        # 2. Kev on Kaggle (GPU → CPU across your accounts); local Kev if that fails.
        if cfg.get("engine_mode") == "kaggle" and self.kaggle.configured and use_jev and not reevaluate:
            self._stage("Running on Kaggle")
            try:
                return self._run_remote(to_triage, raw, *args, len(jobs), len(fresh))
            except KaggleError as e:
                if not cfg.get("local_fallback", True):
                    raise
                self.log(f"Kaggle unavailable ({str(e)[:160]}) — running on this Mac instead")
        # 3. Kev on this Mac (or the keyword heuristic when there is no engine at all).
        if self.engine and use_jev:
            self._stage("Loading the local engine (about a minute)")
        with self.engine.use() if (self.engine and use_jev) else nullcontext():
            return self._run_local(to_triage, raw, profile, candidate, skills, cfg, terms, use_jev, reevaluate,
                                   len(jobs), len(fresh))

    def _run_local(self, to_triage, raw, profile, candidate, skills, cfg, terms, use_jev, reevaluate,
                   n_fetched, n_fresh) -> Dict[str, int]:
        # TRIAGE (new postings + any left untriaged by an earlier, interrupted run) --------
        self._stage("Triage titles" if use_jev else "Triage titles (heuristic)", len(to_triage))
        passed = self._triage(to_triage, candidate) if use_jev else self._triage_heuristic(to_triage, terms)
        self.log(f"{len(passed)} of {len(to_triage)} passed triage")
        # Postings that passed triage earlier but were over the max_deep cap.
        seen = {j["id"] for j in passed}
        backlog = sorted((r for r in raw if r["triage"] and not r["eval"] and r["id"] not in seen),
                         key=lambda r: -(r["triage"]["field"] - 0.5 * r["triage"]["above"]))
        passed += [r["data"] for r in backlog]

        # EVALUATE -------------------------------------------------------
        cap = cfg["max_deep"] if self.jev.is_local else max(cfg["max_deep"], 2000)   # hosted Jev: ~0.4 s and a fraction of a cent per job
        todo = passed[:cap]
        if len(passed) > len(todo):
            self.log(f"{len(passed) - len(todo)} triaged jobs over the cap of {cap}; next run picks them up")
        if reevaluate:
            seen = {j["id"] for j in todo}
            todo += [r["data"] for r in self.db.jobs(["new", "later", "filtered"], limit=100_000 if not self.jev.is_local else cap)
                     if r["id"] not in seen]
        gaps = gap_vocab(skills)
        self._stage("Evaluate postings" if use_jev else "Score (heuristic)", len(todo))
        loaded = self._evaluate(todo, profile, candidate, skills, gaps, cfg, use_jev)

        stats = {"fetched": n_fetched, "fresh": n_fresh, "triaged_in": len(passed),
                 "evaluated": len(todo), "loaded": loaded, "engine": "local" if self.jev.is_local else "jev"}
        self.log(f"✓ Loaded {loaded} jobs onto the board · Jev: {self.jev.usage['requests']} requests, "
                 f"{self.jev.usage['input_tokens']:,} input tokens, {self.jev.usage['cached']} cached")
        return stats

    def _triage(self, jobs: List[dict], candidate: dict) -> List[dict]:
        state = {"candidate": {k: candidate[k] for k in ("headline", "goal", "level", "fields")}}
        scored = []
        batches = [jobs[i:i + Q.TRIAGE_BATCH] for i in range(0, len(jobs), Q.TRIAGE_BATCH)]

        def run(batch):
            return batch, self.jev.ask(state, Q.triage_questions(batch))

        with ThreadPoolExecutor(self._workers()) as ex:
            for fut in as_completed([ex.submit(run, b) for b in batches]):
                batch, ans = fut.result()
                for i, j in enumerate(batch):
                    field, above = ans[f"field_{i}"]["noul"], ans[f"above_{i}"]["noul"]
                    if self._store_triage(j["id"], field, above):
                        scored.append((field - 0.5 * above, j))
                self.state["done"] += len(batch)
        scored.sort(key=lambda x: -x[0])
        return [j for _, j in scored]

    def _store_triage(self, job_id: str, field: float, above: float) -> bool:
        ok = field >= Q.TRIAGE_FIELD_MIN and above <= Q.TRIAGE_ABOVE_MAX
        self.db.update_job(job_id, triage={"field": field, "above": above},
                           status="raw" if ok else "triaged_out",
                           reason=None if ok else ("off-field title" if field < Q.TRIAGE_FIELD_MIN else "title above level"))
        return ok

    def _store_eval(self, job_id: str, ans: Optional[dict], card: dict, skills, gaps) -> bool:
        """Save one evaluation; returns True if the job lands on the board."""
        row = self.db.job(job_id)
        keep_status = row and row["status"] in ("later", "rejected", "applied")
        status = row["status"] if keep_status else ("filtered" if card["gates"] else "new")
        ev = {"answers": ans, "skills": skills, "gaps": gaps} if ans else None
        self.db.update_job(job_id, eval=ev, card=card, match=card["match"], status=status,
                           reason="; ".join(card["gates"]) or None, scored_by=card["scored_by"])
        return status == "new"

    def _run_remote(self, to_triage, raw, profile, candidate, skills, cfg, n_fetched, n_fresh) -> Dict[str, int]:
        gaps = gap_vocab(skills)
        backlog = sorted((r for r in raw if r["triage"] and not r["eval"]),
                         key=lambda r: -(r["triage"]["field"] - 0.5 * r["triage"]["above"]))
        if not to_triage and not backlog:
            self.log("Nothing new to evaluate — no Kaggle run needed")
            return {"fetched": n_fetched, "fresh": n_fresh, "triaged_in": 0, "evaluated": 0, "loaded": 0,
                    "engine": "kaggle"}
        jobs = {j["id"]: j for j in to_triage} | {r["id"]: r["data"] for r in backlog}
        tstate = {"candidate": {k: candidate[k] for k in ("headline", "goal", "level", "fields")}}
        batches = [to_triage[i:i + Q.TRIAGE_BATCH] for i in range(0, len(to_triage), Q.TRIAGE_BATCH)]
        spec = {
            "kev_run": KAGGLE_KEV_RUN, "kev_commit": KEV_COMMIT, "try_fla": True,
            "candidate": candidate, "eval_questions": Q.evaluate_questions(candidate, gaps),
            "triage": {"state": tstate, "batches": [{"ids": [j["id"] for j in b], "questions": Q.triage_questions(b)}
                                                   for b in batches]},
            "jobs": {jid: job_state(j) for jid, j in jobs.items()},
            "backlog": [r["id"] for r in backlog],
            "select": {"field_min": Q.TRIAGE_FIELD_MIN, "above_max": Q.TRIAGE_ABOVE_MAX, "max_deep": cfg["max_deep"]},
        }
        self.log(f"{len(to_triage)} titles to triage, {len(backlog)} triaged earlier and waiting — sending to Kaggle")
        answers = self.kaggle.run(spec)
        passed = sum(self._store_triage(jid, v["field"], v["above"]) for jid, v in answers["triage"].items()
                     if jid in jobs)
        loaded = 0
        for jid, ans in answers["eval"].items():
            if jid in jobs:
                card = score_answers(ans, profile, skills, gaps, cfg["min_match"], jobs[jid])
                loaded += self._store_eval(jid, ans, card, skills, gaps)
        self.log(f"✓ Loaded {loaded} jobs onto the board (Kaggle)")
        return {"fetched": n_fetched, "fresh": n_fresh, "triaged_in": passed, "evaluated": len(answers["eval"]),
                "loaded": loaded, "engine": "kaggle"}

    def _triage_heuristic(self, jobs: List[dict], terms: List[str]) -> List[dict]:
        words = {w.lower() for t in terms for w in t.split()} - {"engineer", "developer"}
        words |= {"ml", "ai", "llm", "python", "backend", "full-stack", "fullstack", "software", "data"}
        out = []
        for j in jobs:
            ok = bool(_tokens(j["title"]) & words)
            self.db.update_job(j["id"], status="raw" if ok else "triaged_out",
                               reason=None if ok else "off-field title (heuristic)")
            if ok:
                out.append(j)
            self.state["done"] += 1
        return out

    def _evaluate(self, jobs, profile, candidate, skills, gaps, cfg, use_jev) -> int:
        questions = Q.evaluate_questions(candidate, gaps) if use_jev else None
        loaded = 0

        def run(job):
            if not use_jev:
                return job, None, heuristic_card(job, profile, skills, cfg["min_match"])
            ans = self.jev.ask({"candidate": candidate, "job": job_state(job)}, questions)
            return job, ans, score_answers(ans, profile, skills, gaps, cfg["min_match"], job)

        with ThreadPoolExecutor(self._workers()) as ex:
            futs = [ex.submit(run, j) for j in jobs]
            for fut in as_completed(futs):
                try:
                    job, ans, card = fut.result()
                except JevError as e:
                    self.log(f"✗ Jev: {e}")
                    self.state["done"] += 1
                    continue
                loaded += self._store_eval(job["id"], ans, card, skills, gaps)
                self.state["done"] += 1
        return loaded

    # -- cheap re-scoring after threshold/weight changes (no Jev calls) --------
    def rescore(self) -> int:
        cfg, profile = self.settings(), self.db.get("profile")
        skills = [k["name"] for k in profile["keywords"] if k["keep"]]
        gaps = gap_vocab(skills)
        n = 0
        for row in self.db.jobs(["new", "filtered"], limit=100_000):
            if row["eval"]:
                ev = row["eval"]
                card = score_answers(ev["answers"], profile, ev["skills"], ev["gaps"], cfg["min_match"], row["data"])
            else:
                card = heuristic_card(row["data"], profile, skills, cfg["min_match"])
            status = "filtered" if card["gates"] else "new"
            n += status == "new"
            self.db.update_job(row["id"], card=card, match=card["match"], status=status,
                               reason="; ".join(card["gates"]) or None)
        return n
