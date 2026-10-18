"""The board's default settings, shared by the server pipeline and the in-browser board."""
from __future__ import annotations

from . import questions as Q
from .sources import DEFAULT_COMPANIES, OPT_IN_SOURCES, SOURCES

# The sources every board saved before 2026-09-25 knew about (anything newer is offered to them once).
LEGACY_SOURCES = ["remotive", "himalayas", "jobicy", "weworkremotely", "arbeitnow", "hackernews", "greenhouse", "ashby", "lever"]

DEFAULT_SETTINGS = {
    "sources": [x for x in SOURCES if x not in OPT_IN_SOURCES],
    "companies": DEFAULT_COMPANIES,
    "min_match": Q.DEFAULT_MIN_MATCH,
    "max_age_days": 45,
    "max_deep": 300,          # cap on deep evaluations per run (highest-triage first)
    "daily_at": "09:00",      # daily run time while the app is open ("" = off); missed runs catch up on start
    "engine_mode": "local",   # "kaggle": decisions run on Kaggle (GPU → CPU), falling back to local Kev
    "workers": 8,
    "plans": {},              # weekly plans: {"2026-W42": {"apply": 8, "reach": 5, "focus": "..."}}
}
