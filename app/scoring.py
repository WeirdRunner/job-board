"""Scoring: a decision engine's answers about one posting -> the card the board shows (match, gates, verdict, chips).

Pure functions with no I/O, shared by the server pipeline (app/pipeline.py) and the in-browser board (app/browser.py,
run by Pyodide), so both score a job exactly the same way.
"""
from __future__ import annotations

import re
from typing import List, Optional

from . import questions as Q
from .lang import detect as detect_language
from .pay import suggest as suggest_pay
from .profile import default_languages

DESC_CHARS = 9000

LEVEL_LABEL = {"internship": "Internship", "entry": "Entry level", "mid": "Mid level",
               "senior": "Senior", "staff_plus": "Staff+ / Manager"}
EXPERIENCE_LABEL = {"not_stated": "Experience not stated", "0_2": "0–2 yrs", "2_4": "2–4 yrs",
                    "4_7": "4–7 yrs", "7_plus": "7+ yrs"}
DEGREE_LABEL = {"none_stated": "No degree listed", "any_degree_or_equivalent": "Any degree / equivalent",
                "cs_engineering_degree": "CS/Eng degree", "advanced_degree": "Master's/PhD"}
MODE_LABEL = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "Onsite", "unclear": ""}
EMPLOYMENT_LABEL = {"full_time": "Full-time", "contract": "Contract", "part_time": "Part-time",
                    "internship": "Internship"}


def _tokens(s: str) -> set:
    return {t for t in re.split(r"[^a-z0-9+#]+", s.lower()) if t}


gap_vocab = Q.gap_vocab


def job_state(job: dict) -> dict:
    return {
        "title": job["title"], "company": job["company"], "location": job["location"],
        "location_restrictions": job.get("location_restrictions") or "",
        "remote": job.get("remote"), "employment_type": job.get("employment_type") or "",
        "salary": job.get("salary") or "", "tags": job.get("tags")[:12] if job.get("tags") else [],
        "description": (job.get("description") or "")[:DESC_CHARS],
    }


# ---------------------------------------------------------------------------
# SCORE: answers -> card (pure; re-runnable without new Jev calls)
# ---------------------------------------------------------------------------

# Where a posting says it is, checked against where you are — a plain-text sanity check on Kev's location call.
CITIES = {"India": r"india|bengaluru|bangalore|mumbai|delhi|gurugram|gurgaon|noida|hyderabad|pune|chennai|kolkata|"
                   r"ahmedabad|jaipur|chandigarh|kochi|indore|coimbatore|thiruvananthapuram|dehradun",
          "United States": r"usa|u\.s\.|united states|new york|nyc|san francisco|sf bay|seattle|austin|boston|chicago|los angeles|denver",
          "United Kingdom": r"uk|united kingdom|london|manchester|edinburgh|cambridge|bristol",
          "Germany": r"germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart",
          "France": r"france|paris|lyon|lille|toulouse|marseille",
          "Netherlands": r"netherlands|amsterdam|rotterdam|utrecht|eindhoven",
          "Spain": r"spain|madrid|barcelona|valencia",
          "Canada": r"canada|toronto|vancouver|montreal|ottawa|waterloo",
          "Poland": r"poland|warsaw|kraków|krakow|wrocław|wroclaw",
          "Brazil": r"brazil|brasil|são paulo|sao paulo|rio de janeiro",
          "Singapore": r"singapore",
          "Australia": r"australia|sydney|melbourne|brisbane",
          "United Arab Emirates": r"uae|united arab emirates|dubai|abu dhabi"}
ANYWHERE = re.compile(r"\b(anywhere|worldwide|global(ly)?|any location|all locations|remote[- ]first|fully distributed)\b", re.I)
ELSEWHERE = re.compile(r"\b(usa?|u\.s\.a?\.?|united states|canada|uk|united kingdom|europe|eu|emea|germany|france|spain|poland|"
                       r"netherlands|ireland|portugal|brazil|mexico|latam|north america|americas|australia|singapore|japan|"
                       r"new york|san francisco|london|berlin|paris|amsterdam|toronto|seattle|austin|boston|nyc|sf)\b", re.I)


def listed_location(job: Optional[dict], country: str) -> Optional[str]:
    """'yours' if the posting lists your country (or a city in it), 'elsewhere' if it only lists other places,
    None if it says nothing useful (or 'anywhere')."""
    if not job or not country:
        return None
    text = " ".join(str(job.get(k) or "") for k in ("location", "location_restrictions"))
    if not text.strip():
        return None
    if re.search(rf"\b({CITIES.get(country, re.escape(country.lower()))})\b", text, re.I):
        return "yours"
    if ANYWHERE.search(text):
        return None
    return "elsewhere" if ELSEWHERE.search(text) else None


def score_answers(a: dict, profile: dict, skills: List[str], gaps: List[str], min_match: float,
                  job: Optional[dict] = None) -> dict:
    cand_level = profile.get("level") or "entry"
    country = profile.get("country") or "your country"
    lp = a["level"]["probabilities"]
    ep = a["experience"]["probabilities"]
    level_fit = sum(p * Q.LEVEL_FIT[cand_level].get(k, 0) for k, p in lp.items())
    exp_fit = sum(p * Q.EXPERIENCE_FIT[cand_level].get(k, 0) for k, p in ep.items())
    comp = {
        "skill_alignment": a["skill_alignment"]["score"] / 4,
        "interest_alignment": a["interest_alignment"]["score"] / 3,
        "should_apply": a["should_apply"]["noul"],
        "level_fit": level_fit,
        "experience_fit": exp_fit,
    }
    match = 100 * sum(Q.WEIGHTS[k] * v for k, v in comp.items())

    loc, deg = a["location"], a["degree"]
    lprob, dprob = loc["probabilities"], deg["probabilities"]
    if dprob.get("advanced_degree", 0) > 0.6:
        match -= Q.ADVANCED_DEGREE_PENALTY
    if lprob.get("unclear", 0) > 0.6:
        match -= Q.UNCLEAR_LOCATION_PENALTY
    match = max(0.0, min(100.0, match))

    gates = []
    if a["tech_role"]["noul"] < Q.GATE_TECH_ROLE_MIN:
        gates.append("Not a hands-on technical role")
    if a["field"]["probabilities"].get("non_engineering", 0) > Q.GATE_NON_ENGINEERING_MAX:
        gates.append("Non-engineering field")
    eligible = lprob.get("remote_open", 0) + lprob.get("local_office", 0) + 0.5 * lprob.get("unclear", 0)
    listed = listed_location(job, profile.get("country") or "")
    if listed == "yours":
        eligible = max(eligible, 1.0)            # the posting itself names your country/city
        if lprob.get("unclear", 0) > 0.6:
            match = min(100.0, match + Q.UNCLEAR_LOCATION_PENALTY)
    if eligible < Q.GATE_LOCATION_ELIGIBLE_MIN:
        gates.append(f"Not open to candidates in {country}")
    if level_fit < Q.GATE_LEVEL_FIT_MIN:
        gates.append("Level above yours")
    if exp_fit < Q.GATE_EXPERIENCE_FIT_MIN:
        gates.append("Asks for much more experience")
    if a["skill_alignment"]["score"] < Q.GATE_SKILL_MIN:
        gates.append("Few of your core skills")
    if a["red_flags"]["noul"] > Q.GATE_RED_FLAGS_MAX:
        gates.append("Red flags (scam/unpaid/vague)")
    speaks = [x.lower() for x in (profile.get("languages") or default_languages(profile.get("country", "")))]
    written_in = detect_language(f"{job.get('title', '')}\n{job.get('description', '')}") if job else None
    if written_in and written_in.lower() not in speaks:
        gates.append(f"Posting is in {written_in}")
    elif a.get("other_language", {}).get("noul", 0) > Q.GATE_OTHER_LANGUAGE_MAX:
        gates.append("Needs a language you don't list")
    if match < min_match:
        gates.append(f"Match {match:.0f} below {min_match:.0f}")

    confs = [loc["confidence"], a["level"]["confidence"], a["skill_alignment"]["confidence"]]
    confidence = sum(confs) / len(confs)
    matched = [s for i, s in enumerate(skills) if a.get(f"has_{i}", {}).get("noul", 0) >= Q.SKILL_MATCH_MIN]
    missing = [s for i, s in enumerate(gaps) if a.get(f"gap_{i}", {}).get("noul", 0) >= Q.SKILL_MATCH_MIN]
    rank = {k["name"]: (k.get("core", False), k.get("used") or 0, k.get("market") or 0) for k in profile.get("keywords") or []}
    matched.sort(key=lambda s: rank.get(s, (False, 0, 0)), reverse=True)       # your core skills first
    lead = a.get("lead_project", {}).get("choice")

    loc_choice = loc["choice"]
    if listed == "yours" and loc_choice not in ("remote_open", "local_office"):
        loc_choice = "remote_open" if re.search(r"\bremote\b", str(job.get("location") or ""), re.I) else "local_office"
    loc_label = {"remote_open": f"Remote · open to {country}", "local_office": f"Office in {country}",
                 "restricted": "Location-restricted", "unclear": "Location unclear"}[loc_choice]
    sk, ia = a["skill_alignment"], a["interest_alignment"]
    reasons = [
        f"Skills: {sk['legend'][str(round(sk['score']))]} ({sk['score']:.1f}/4)",
        f"Goal fit: {ia['legend'][str(round(ia['score']))]}",
        f"Level: {LEVEL_LABEL[a['level']['choice']]} ({lp[a['level']['choice']]:.0%}) · asks {EXPERIENCE_LABEL[a['experience']['choice']]}",
        f"Location: {loc_label} ({lprob[loc['choice']]:.0%})",
        f"Verdict: {'worth applying' if comp['should_apply'] >= 0.5 else 'long shot'} ({comp['should_apply']:.0%})",
    ]
    tier = "strong" if match >= 75 else "good" if match >= 60 else "stretch"
    mode = MODE_LABEL[a["work_mode"]["choice"]]
    chips = [loc_label,
             mode if mode and not loc_label.startswith(mode) else "",          # "Remote · open to India" says it already
             LEVEL_LABEL[a["level"]["choice"]],
             EXPERIENCE_LABEL[a["experience"]["choice"]] if a["experience"]["choice"] != "not_stated" else "",
             EMPLOYMENT_LABEL[a["employment"]["choice"]] if a["employment"]["choice"] != "full_time" else "",
             DEGREE_LABEL[deg["choice"]] if deg["choice"] in ("cs_engineering_degree", "advanced_degree") else "",
             f"In {written_in}" if written_in and written_in != "English" else ""]
    return {
        "match": round(match), "tier": tier, "confidence": round(confidence, 3),
        "unsure": confidence < Q.LOW_CONFIDENCE,
        "chips": list(dict.fromkeys(c for c in chips if c)),          # "Internship" can be both level and job type
        "location_ok": loc_choice in ("remote_open", "local_office") and listed != "elsewhere",
        "pay": suggest_pay(job, a["level"]["choice"], cand_level, profile.get("country") or "",
                           local=listed == "yours" or loc_choice == "local_office")
               if job and job.get("kind") != "gig" else None,                  # a gig shows its own budget instead
        "skills_matched": matched, "skills_gap": missing,
        "lead_project": None if lead in (None, "none") else lead,
        "take": kev_take(a, comp, cand_level, loc_choice, loc_label, matched, missing, confidence,
                         language=written_in if written_in and written_in.lower() not in speaks else
                         ("another language" if a.get("other_language", {}).get("noul", 0) > 0.5 else None),
                         listed_elsewhere=(job or {}).get("location") if listed == "elsewhere" else None),
        "reasons": reasons, "gates": gates,
        "components": {k: round(v, 3) for k, v in comp.items()},
        "scored_by": "jev",
    }


def _list(xs: List[str], n: int = 4) -> str:
    return ", ".join(xs[:n]) + (f" +{len(xs) - n}" if len(xs) > n else "")


def kev_take(a: dict, comp: dict, cand_level: str, loc_choice: str, loc_label: str,
             matched: List[str], missing: List[str], confidence: float, listed_elsewhere: Optional[str] = None,
             language: Optional[str] = None) -> dict:
    """Kev's answers as a short verdict plus the few points that matter — no probabilities or rubric text."""
    pros, cons = [], []
    if language:                                        # first: it usually settles it
        cons.append(f"Written in {language} — they'll expect you to work in it" if language != "another language"
                    else "Asks for a language you don't list")
    sk = comp["skill_alignment"]
    if sk >= 0.7:
        pros.append(f"Strong skill overlap{': ' + _list(matched) if matched else ''}")
    elif sk >= 0.45:
        pros.append(f"Some skill overlap{': ' + _list(matched) if matched else ''}")
    else:
        cons.append("Few of your skills are what they need")
    if missing:
        cons.append(f"They also want {_list(missing, 3)}")
    if comp["interest_alignment"] >= 0.8:
        pros.append("The kind of role you're after")
    elif comp["interest_alignment"] < 0.5:
        cons.append("Off your stated goal")
    if listed_elsewhere and loc_choice != "restricted":
        cons.append(f"Listed for {listed_elsewhere.strip()[:60]} — check they hire where you are")
    elif loc_choice == "restricted":
        cons.append("Probably limited to other countries — check before applying")
    elif loc_choice == "unclear":
        cons.append("Location unclear — check before applying")
    # (an open location is already the first chip on the card)
    job_level = a["level"]["choice"]
    if comp["level_fit"] >= 0.75:
        pros.append(f"Right level ({LEVEL_LABEL[job_level].lower()})")
    elif comp["level_fit"] < 0.6:
        cons.append(f"Pitched at {LEVEL_LABEL[job_level].lower()} — a stretch from {LEVEL_LABEL.get(cand_level, cand_level).lower()}")
    if comp["experience_fit"] < 0.6 and a["experience"]["choice"] != "not_stated":
        cons.append(f"Asks for {EXPERIENCE_LABEL[a['experience']['choice']]} of experience")
    if a["degree"]["probabilities"].get("advanced_degree", 0) > 0.5:
        cons.append("Wants a Master's or PhD")
    if a["red_flags"]["noul"] > 0.3:
        cons.append("Some red flags in the posting")
    sa = comp["should_apply"]
    verdict = "Worth applying" if sa >= 0.75 else "Worth a look" if sa >= 0.5 else "Long shot"
    lead = pros[0].split(":")[0].lower() if pros else ""
    summary = verdict + (f" — {lead}" if lead else "") + (f", but {cons[0][0].lower() + cons[0][1:]}" if cons and sa < 0.75 else "")
    return {"verdict": verdict, "summary": summary + ".", "pros": pros[:4], "cons": cons[:3],
            "unsure": confidence < Q.LOW_CONFIDENCE}


def heuristic_card(job: dict, profile: dict, skills: List[str], min_match: float) -> dict:
    """Fallback when no Jev key is configured: plain keyword overlap. Clearly labelled on the card."""
    text = f"{job['title']}\n{job.get('description', '')}".lower()
    hit = [s for s in skills if re.search(r"(?<![a-z0-9])" + re.escape(s.lower()) + r"(?![a-z0-9])", text)]
    loc = f"{job.get('location', '')} {job.get('location_restrictions', '')}".lower()
    country = (profile.get("country") or "").lower()
    loc_ok = bool(country and country in loc) or bool(re.search(r"anywhere|worldwide|global", loc))
    senior = bool(re.search(r"\b(senior|sr\.?|staff|principal|lead|head|director|manager)\b", job["title"], re.I))
    match = min(100, 12 * len(hit)) * (0.5 if senior else 1.0) * (1.0 if loc_ok else 0.7)
    gates = [] if match >= min_match else [f"Match {match:.0f} below {min_match:.0f}"]
    return {
        "match": round(match), "tier": "strong" if match >= 75 else "good" if match >= 60 else "stretch",
        "confidence": None, "unsure": True, "chips": ["Heuristic score (no Jev key)"],
        "location_ok": loc_ok, "skills_matched": hit[:12], "skills_gap": [], "lead_project": None,
        "reasons": [f"{len(hit)} of your skills appear in the posting", "Add a Jev key for real scoring"],
        "gates": gates, "components": {}, "scored_by": "heuristic",
    }
