"""EXTRACT: job sources. Each adapter returns jobs in one normalized shape.

Only public, unauthenticated feeds/APIs are used (no LinkedIn/Indeed/Naukri scraping,
which their terms forbid and which block bots anyway).

Normalized job:
  id, source, title, company, location, remote, url, description, salary,
  posted_at (ISO date), tags (list), employment_type, location_restrictions, logo
"""
from __future__ import annotations

import hashlib
import html
import re
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

import requests
from bs4 import BeautifulSoup

UA = {"User-Agent": "JobBoard/1.0 (personal, self-hosted job board; +https://github.com/WeirdRunner/job-board)"}
# Where each source's jobs come from — cards link "via <source>" here (attribution the sources ask for).
SOURCE_HOME = {"remotive": "https://remotive.com", "himalayas": "https://himalayas.app", "jobicy": "https://jobicy.com",
               "weworkremotely": "https://weworkremotely.com", "arbeitnow": "https://www.arbeitnow.com",
               "hackernews": "https://news.ycombinator.com", "greenhouse": "https://www.greenhouse.com",
               "ashby": "https://www.ashbyhq.com", "lever": "https://www.lever.co",
               "remoteok": "https://remoteok.com", "workingnomads": "https://www.workingnomads.com",
               "themuse": "https://www.themuse.com", "smartrecruiters": "https://www.smartrecruiters.com",
               "freelancer": "https://www.freelancer.com"}
# We Work Remotely's API terms are stricter than its RSS page, so it's opt-in for new boards. Freelancer.com's API
# terms ask that stored data be refreshed within 24 hours and kept encrypted, so it's opt-in too (and expires daily).
OPT_IN_SOURCES = {"weworkremotely", "freelancer"}
# Sources whose postings are freelance gigs rather than jobs (other postings become gigs when they say "freelance").
GIG_SOURCES = {"freelancer"}
FREELANCE = re.compile(r"\bfreelance|\bcontractor\b|\bgig\b|per project|project[- ]based", re.I)
# Freelancer.com's text search barely filters, so keep only projects tagged with technical skills.
TECH_TAG = re.compile(r"python|machine learning|\bai\b|artificial intelligence|deep learning|\bllm|nlp|computer vision|"
                      r"data (science|engineering|analysis|processing)|software|web (development|scraping)|\bapi\b|"
                      r"backend|frontend|full stack|react|node|javascript|typescript|django|fastapi|flask|sql|"
                      r"automation|chatbot|devops|docker|cloud", re.I)
TIMEOUT = 25

DEFAULT_COMPANIES = {
    "greenhouse": ["razorpaysoftwareprivatelimited", "groww", "hackerrank", "druva", "gitlab",
                   "mongodb", "databricks", "stripe", "coinbase", "elastic", "cloudflare",
                   "scaleai", "anthropic",
                   # hire in India (checked 2026-09-25)
                   "okta", "zscaler", "twilio", "toast", "samsara", "airbnb", "datadog", "mixpanel"],
    "ashby": ["sarvam", "openai", "deepgram", "supabase", "cursor", "replit", "ramp", "langchain",
              "elevenlabs", "posthog", "atlan", "composio", "perplexity", "notion", "cohere", "modal",
              "harvey", "anyscale"],
    "lever": ["paytm", "cred", "zeta", "palantir"],
    # SmartRecruiters company ids (Freshworks and Swiggy are Indian; checked 2026-09-25)
    "smartrecruiters": ["Freshworks", "Swiggy", "ServiceNow", "Canva", "Experian", "NielsenIQ"],
}


# Ashby/Lever only give the board slug; show the real names for the defaults.
COMPANY_NAMES = {"openai": "OpenAI", "anyscale": "Anyscale", "harvey": "Harvey", "elevenlabs": "ElevenLabs", "posthog": "PostHog", "langchain": "LangChain",
                 "cred": "CRED", "paytm": "Paytm", "sarvam": "Sarvam AI", "supabase": "Supabase"}


def _company_name(slug: str) -> str:
    return COMPANY_NAMES.get(slug, slug.replace("-", " ").title())


_BLOCKS = ["p", "div", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "section", "article",
           "header", "footer", "blockquote", "pre", "hr"]


def html_to_text(s: Optional[str]) -> str:
    """Readable text from a posting's HTML: paragraphs and bullets on their own lines, inline tags (links, bold)
    kept inline, and links whose text is a shortened URL (HN shows "https://jobs.ashbyhq.com/x/2c12...")
    replaced by the real address."""
    if not s:
        return ""
    s = html.unescape(s) if "&lt;" in s else s
    soup = BeautifulSoup(s, "html.parser")
    for a in soup.find_all("a", href=True):
        t, href = a.get_text().strip(), a["href"].strip()
        short = t.rstrip(".…").strip()
        if href.startswith("http") and (t.endswith(("...", "…")) or (short and href.startswith(short) and len(href) > len(short))):
            a.replace_with(href)
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for li in soup.find_all("li"):
        li.insert_before("\n- ")
        li.insert_after("\n")
    for tag in soup.find_all(_BLOCKS):
        tag.insert_before("\n\n")
        tag.insert_after("\n\n")
    text = soup.get_text()
    text = re.sub(r"[ \t\xa0]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n- *\n+", "\n- ", text)                 # a bullet whose text started on the next line
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"(?m)^(- .*)\n\n(?=- )", r"\1\n", text)       # one list, not a blank line per bullet
    return re.sub(r"(?m)^(- .*)\n\n(?=- )", r"\1\n", text).strip()


def _iso(v) -> Optional[str]:
    if v in (None, "", "None"):
        return None
    try:
        if isinstance(v, (int, float)) or str(v).isdigit():
            n = float(v)
            return datetime.fromtimestamp(n / 1000 if n > 1e12 else n, timezone.utc).date().isoformat()
        return str(v)[:10]
    except Exception:
        return None


def _job(source: str, source_id, **kw) -> dict:
    j = {"source": source, "title": "", "company": "", "location": "", "remote": None, "url": "",
         "description": "", "salary": "", "posted_at": None, "tags": [], "employment_type": "",
         "location_restrictions": "", "logo": "", "kind": "job", "bids": None}
    j.update({k: v for k, v in kw.items() if v is not None})
    j["id"] = hashlib.sha1(f"{source}:{source_id}".encode()).hexdigest()[:16]
    j["title"] = re.sub(r"\s+", " ", j["title"]).strip()
    return j


def _get(session: requests.Session, url: str, **params):
    r = session.get(url, params=params or None, headers=UA, timeout=TIMEOUT)
    r.raise_for_status()
    return r


# ---------------------------------------------------------------------------
# Search-based sources (use the Jev-selected search terms)
# ---------------------------------------------------------------------------

def remotive(s, terms, companies, log):
    """One unfiltered call per run (Remotive allows ~2 requests/minute and suggests ≤4 fetches a day);
    title triage filters the feed."""
    out = []
    for t in [None]:
        for j in _get(s, "https://remotive.com/api/remote-jobs").json().get("jobs", []):
            out.append(_job("remotive", j["id"], title=j["title"], company=j["company_name"],
                            location=j.get("candidate_required_location", ""), remote=True, url=j["url"],
                            description=html_to_text(j.get("description")), salary=j.get("salary") or "",
                            posted_at=_iso(j.get("publication_date")), tags=j.get("tags") or [],
                            employment_type=j.get("job_type", ""), logo=j.get("company_logo") or "",
                            location_restrictions=j.get("candidate_required_location", "")))
    return out


def himalayas(s, terms, companies, log, pages=3):
    out = []
    for t in terms:
        for page in range(1, pages + 1):                 # the search endpoint pages with ?page= (no cursor)
            d = _get(s, "https://himalayas.app/jobs/api/search", q=t, page=page).json()
            for j in d.get("jobs", []):
                restr = ", ".join(j.get("locationRestrictions") or []) or "Worldwide"
                sal = ""
                if j.get("minSalary"):
                    sal = f"{j.get('currency', '')} {j['minSalary']:,}–{j.get('maxSalary') or ''} / {j.get('salaryPeriod', 'year')}"
                out.append(_job("himalayas", j["guid"], title=j["title"], company=j["companyName"],
                                location=restr[:200], remote=True, url=j["applicationLink"],
                                description=html_to_text(j.get("description")), salary=sal,
                                posted_at=_iso(j.get("pubDate")), tags=j.get("categories") or [],
                                employment_type=j.get("employmentType", ""), logo=j.get("companyLogo") or "",
                                location_restrictions=restr))
            if len(d.get("jobs", [])) < 20:
                break
    return out


def jobicy(s, terms, companies, log):
    out = []
    for t in terms:
        try:
            jobs = _get(s, "https://jobicy.com/api/v2/remote-jobs", count=50, tag=t).json().get("jobs", [])
        except requests.HTTPError:
            continue
        for j in jobs:
            sal = ""
            if j.get("annualSalaryMin"):
                sal = f"{j.get('salaryCurrency', '')} {j['annualSalaryMin']}–{j.get('annualSalaryMax', '')} / year"
            out.append(_job("jobicy", j["id"], title=html.unescape(j["jobTitle"]), company=j["companyName"],
                            location=j.get("jobGeo", ""), remote=True, url=j["url"],
                            description=html_to_text(j.get("jobDescription")), salary=sal,
                            posted_at=_iso(j.get("pubDate")), tags=j.get("jobIndustry") or [],
                            employment_type=", ".join(j.get("jobType") or []), logo=j.get("companyLogo") or "",
                            location_restrictions=j.get("jobGeo", "")))
    return out


# ---------------------------------------------------------------------------
# Feed sources (no search; Jev title triage filters them)
# ---------------------------------------------------------------------------

def arbeitnow(s, terms, companies, log, pages=2):
    out = []
    for page in range(1, pages + 1):
        for j in _get(s, "https://www.arbeitnow.com/api/job-board-api", page=page).json().get("data", []):
            out.append(_job("arbeitnow", j["slug"], title=j["title"], company=j["company_name"],
                            location=j.get("location", ""), remote=j.get("remote"), url=j["url"],
                            description=html_to_text(j.get("description")),
                            posted_at=_iso(j.get("created_at")), tags=j.get("tags") or [],
                            employment_type=", ".join(j.get("job_types") or [])))
    return out


WWR_CATEGORIES = ["remote-full-stack-programming-jobs", "remote-back-end-programming-jobs",
                  "remote-front-end-programming-jobs", "remote-devops-sysadmin-jobs", "all-other-remote-jobs"]


def weworkremotely(s, terms, companies, log):
    out = []
    for cat in WWR_CATEGORIES:
        root = ET.fromstring(_get(s, f"https://weworkremotely.com/categories/{cat}.rss").content)
        for it in root.iter("item"):
            g = lambda tag: (it.findtext(tag) or "").strip()
            company, _, title = g("title").partition(": ")
            region = g("region")
            countries = g("country")
            out.append(_job("weworkremotely", g("guid") or g("link"), title=title or company,
                            company=company if title else "", location=region, remote=True, url=g("link"),
                            description=html_to_text(g("description")), posted_at=_iso(_rfc822(g("pubDate"))),
                            tags=[x.strip() for x in g("skills").replace(" and ", ", ").split(",") if x.strip()],
                            employment_type=g("type"),
                            location_restrictions=f"{region}; {countries}"[:600] if countries else region))
    return out


def _rfc822(v: str) -> Optional[str]:
    try:
        return datetime.strptime(v[:25], "%a, %d %b %Y %H:%M:%S").date().isoformat()
    except Exception:
        return None


def hackernews(s, terms, companies, log):
    """Latest 'Ask HN: Who is hiring?' thread; each top-level comment is one posting."""
    hits = _get(s, "https://hn.algolia.com/api/v1/search_by_date",
                tags="story,author_whoishiring", hitsPerPage=6).json()["hits"]
    story = next((h for h in hits if "who is hiring" in h["title"].lower()), None)
    if not story:
        return []
    item = _get(s, f"https://hn.algolia.com/api/v1/items/{story['objectID']}").json()
    out = []
    for c in item.get("children", []):
        text = html_to_text(c.get("text"))
        if not text or len(text) < 80:
            continue
        first = text.split("\n", 1)[0]
        parts = [p.strip() for p in first.split("|")]
        remote = bool(re.search(r"\bremote\b", first, re.I))
        out.append(_job("hackernews", c["id"], title=first[:160], company=parts[0][:80],
                        location=" | ".join(parts[1:])[:200], remote=remote,
                        url=f"https://news.ycombinator.com/item?id={c['id']}", description=text,
                        posted_at=_iso(c.get("created_at"))))
    return out


# ---------------------------------------------------------------------------
# Company applicant-tracking boards (Greenhouse / Ashby / Lever)
# ---------------------------------------------------------------------------

def pmap(fn, items, workers: int) -> list:
    """map() across a thread pool; one item at a time in the browser (Pyodide has no threads)."""
    if sys.platform == "emscripten":
        return list(map(fn, items))
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


def _per_company(fn, companies, log):
    out = []
    for co, res in zip(companies, pmap(lambda c: _safe(fn, c), companies, 8)):
        if isinstance(res, Exception):
            log(f"  {fn.__name__}:{co} failed: {res}")
        else:
            out.extend(res)
    return out


def _safe(fn, c):
    try:
        return fn(c)
    except Exception as e:  # one dead board shouldn't sink the source
        return e


def greenhouse(s, terms, companies, log):
    def one(co):
        d = _get(s, f"https://boards-api.greenhouse.io/v1/boards/{co}/jobs", content="true").json()
        res = []
        for j in d.get("jobs", []):
            loc = (j.get("location") or {}).get("name", "")
            res.append(_job("greenhouse", j["id"], title=j["title"], company=j.get("company_name") or co,
                            location=loc, remote="remote" in loc.lower(), url=j["absolute_url"],
                            description=html_to_text(j.get("content")),
                            posted_at=_iso(j.get("first_published") or j.get("updated_at")),
                            tags=[x["name"] for x in j.get("departments", [])]))
        return res
    return _per_company(one, companies.get("greenhouse", []), log)


def ashby(s, terms, companies, log):
    def one(co):
        d = _get(s, f"https://api.ashbyhq.com/posting-api/job-board/{co}", includeCompensation="true").json()
        res = []
        for j in d.get("jobs", []):
            if not j.get("isListed", True):
                continue
            locs = [j.get("location", "")] + [x.get("location", "") for x in j.get("secondaryLocations") or []]
            comp = (j.get("compensation") or {}).get("scrapeableCompensationSalarySummary") or ""
            res.append(_job("ashby", j["id"], title=j["title"], company=_company_name(co),
                            location=" / ".join(l for l in locs if l), remote=j.get("isRemote"),
                            url=j["jobUrl"], description=j.get("descriptionPlain") or html_to_text(j.get("descriptionHtml")),
                            salary=comp, posted_at=_iso(j.get("publishedAt")),
                            tags=[x for x in (j.get("department"), j.get("team")) if x],
                            employment_type=j.get("employmentType", ""),
                            location_restrictions=j.get("workplaceType", "")))
        return res
    return _per_company(one, companies.get("ashby", []), log)


def lever(s, terms, companies, log):
    def one(co):
        res = []
        for j in _get(s, f"https://api.lever.co/v0/postings/{co}", mode="json").json():
            cat = j.get("categories") or {}
            loc = cat.get("location") or ", ".join(cat.get("allLocations") or [])
            desc = (j.get("descriptionPlain") or "") + "\n\n" + "\n\n".join(
                f"{l.get('text', '')}\n{html_to_text(l.get('content'))}" for l in j.get("lists", []))
            res.append(_job("lever", j["id"], title=j["text"], company=_company_name(co), location=loc,
                            remote=j.get("workplaceType") == "remote", url=j["hostedUrl"],
                            description=desc.strip(), posted_at=_iso(j.get("createdAt")),
                            tags=[x for x in (cat.get("team"), cat.get("department")) if x],
                            employment_type=cat.get("commitment", ""),
                            location_restrictions=j.get("workplaceType", "")))
        return res
    return _per_company(one, companies.get("lever", []), log)


def _demangle(t: str) -> str:
    """Undo UTF-8 text that was decoded as Latin-1 upstream ("MecÃ¡nico" -> "Mecánico"); leave anything else alone."""
    if not re.search("[ÃÂ][\u0080-\u00bf]", t):
        return t
    try:
        return t.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return t


def remoteok(s, terms, companies, log):
    """Remote OK's public API. Its terms: link back to Remote OK and credit it (cards say "via Remote OK")."""
    out = []
    for j in _get(s, "https://remoteok.com/api").json()[1:]:          # [0] is the legal notice
        j = {k: _demangle(v) if isinstance(v, str) else v for k, v in j.items()}
        sal = f"USD {j['salary_min']:,}–{j['salary_max']:,} / year" if j.get("salary_min") and j.get("salary_max") else ""
        out.append(_job("remoteok", j["id"], title=j.get("position", ""), company=j.get("company", ""),
                        location=j.get("location") or "Remote", remote=True, url=j.get("url") or j.get("apply_url", ""),
                        description=html_to_text(j.get("description")), salary=sal, posted_at=_iso(j.get("date")),
                        tags=j.get("tags") or [], logo=j.get("company_logo") or j.get("logo") or "",
                        location_restrictions=j.get("location") or ""))
    return out


def workingnomads(s, terms, companies, log):
    out = []
    for j in _get(s, "https://www.workingnomads.com/api/exposed_jobs/").json():
        tags = [t.strip() for t in (j.get("tags") or "").split(",") if t.strip()] if isinstance(j.get("tags"), str) else (j.get("tags") or [])
        out.append(_job("workingnomads", j["url"], title=j.get("title", ""), company=j.get("company_name", ""),
                        location=j.get("location") or "Remote", remote=True, url=j["url"],
                        description=html_to_text(j.get("description")), posted_at=_iso(j.get("pub_date")),
                        tags=[j.get("category_name")] + tags if j.get("category_name") else tags,
                        location_restrictions=j.get("location") or ""))
    return out


MUSE_CATEGORIES = ["Software Engineering", "Data and Analytics", "Data Science", "Computer and IT"]


def themuse(s, terms, companies, log, pages=3):
    """The Muse's public API (no key needed at this volume). Its terms: link back to The Muse."""
    out = []
    for cat in MUSE_CATEGORIES:
        for page in range(pages):
            d = _get(s, "https://www.themuse.com/api/public/jobs", page=page, category=cat, descending="true").json()
            for j in d.get("results", []):
                locs = [x["name"] for x in j.get("locations") or []]
                levels = [x["name"] for x in j.get("levels") or []]
                out.append(_job("themuse", j["id"], title=j.get("name", ""), company=(j.get("company") or {}).get("name", ""),
                                location=" / ".join(locs), remote=any("remote" in l.lower() for l in locs),
                                url=(j.get("refs") or {}).get("landing_page", ""), description=html_to_text(j.get("contents")),
                                posted_at=_iso(j.get("publication_date")),
                                tags=[x["name"] for x in j.get("categories") or []] + levels))
            if page + 1 >= d.get("page_count", 0):
                break
    return out


def smartrecruiters(s, terms, companies, log, per_company=25):
    """Companies' public SmartRecruiters postings. The list has no text, so the newest few get a detail call each."""
    def one(co):
        listing = _get(s, f"https://api.smartrecruiters.com/v1/companies/{co}/postings", limit=100).json().get("content", [])
        listing.sort(key=lambda j: j.get("releasedDate") or "", reverse=True)
        res = []
        for j in listing[:per_company]:
            d = _get(s, f"https://api.smartrecruiters.com/v1/companies/{co}/postings/{j['id']}").json()
            sec = (d.get("jobAd") or {}).get("sections") or {}
            text = "\n\n".join(html_to_text((sec.get(k) or {}).get("text")) for k in
                                ("jobDescription", "qualifications", "additionalInformation", "companyDescription"))
            loc = j.get("location") or {}
            where = ", ".join(x for x in (loc.get("city"), loc.get("region"), loc.get("country", "").upper()) if x)
            res.append(_job("smartrecruiters", j["id"], title=j.get("name", ""), company=(j.get("company") or {}).get("name") or co,
                            location=("Remote · " if loc.get("remote") else "") + where, remote=bool(loc.get("remote")),
                            url=d.get("postingUrl") or f"https://jobs.smartrecruiters.com/{co}/{j['id']}",
                            description=text.strip(), posted_at=_iso(j.get("releasedDate")),
                            employment_type=(j.get("typeOfEmployment") or {}).get("label", ""),
                            tags=[x for x in ((j.get("function") or {}).get("label"), (j.get("experienceLevel") or {}).get("label")) if x]))
        return res
    return _per_company(one, companies.get("smartrecruiters", []), log)


# ---------------------------------------------------------------------------
# Freelance gigs (HN's "Freelancer? Seeking freelancer?" thread was checked too: Jul-Oct 2026 it held only
# SEEKING WORK posts, no work on offer, so it isn't a source)
# ---------------------------------------------------------------------------

def freelancer(s, terms, companies, log, per_term=25):
    """Freelancer.com's public project API (its API terms: refresh within 24 h, store encrypted — see OPT_IN_SOURCES)."""
    out, seen = [], set()
    for t in (terms or ["python"])[:6]:
        d = _get(s, "https://www.freelancer.com/api/projects/0.1/projects/active/", query=t, limit=per_term,
                 full_description="true", job_details="true", compact="true", **{"languages[]": "en"}).json()
        for p in (d.get("result") or {}).get("projects") or []:
            tags = [j.get("name") for j in p.get("jobs") or [] if j.get("name")]
            if p["id"] in seen or not any(TECH_TAG.search(t) for t in tags):
                continue
            seen.add(p["id"])
            b, cur = p.get("budget") or {}, (p.get("currency") or {}).get("code", "")
            hourly = p.get("type") == "hourly"
            lo, hi = b.get("minimum"), b.get("maximum")
            budget = (f"{cur} {lo:,.0f}" + (f"–{hi:,.0f}" if hi else "+") + (" / hour" if hourly else " fixed")) if lo else ""
            out.append(_job("freelancer", p["id"], title=p.get("title", ""), company="Freelancer.com client",
                            location="Remote", remote=True, url=f"https://www.freelancer.com/projects/{p.get('seo_url', p['id'])}",
                            description=p.get("description") or "", salary=budget, posted_at=_iso(p.get("time_submitted")),
                            tags=tags, employment_type="hourly freelance" if hourly else "fixed-price freelance", kind="gig",
                            bids=(p.get("bid_stats") or {}).get("bid_count")))
    return out


SOURCES: Dict[str, Callable] = {
    "remotive": remotive, "himalayas": himalayas, "jobicy": jobicy, "weworkremotely": weworkremotely,
    "arbeitnow": arbeitnow, "hackernews": hackernews, "greenhouse": greenhouse, "ashby": ashby,
    "lever": lever, "remoteok": remoteok, "workingnomads": workingnomads, "themuse": themuse,
    "smartrecruiters": smartrecruiters, "freelancer": freelancer,
}


def fetch_all(enabled: List[str], terms: List[str], companies: Dict[str, List[str]], log) -> List[dict]:
    session = requests.Session()
    jobs: List[dict] = []

    def run(name):
        try:
            return name, SOURCES[name](session, terms, companies, log)
        except Exception as e:
            return name, e

    names = [n for n in enabled if n in SOURCES]
    results = pmap(run, names, 6)
    for name, res in results:
        if isinstance(res, Exception):
            log(f"✗ {name}: {res}")
        else:
            log(f"✓ {name}: {len(res)} postings")
            jobs.extend(res)
    for j in jobs:      # a freelance posting on a job board is a gig too
        if j.get("kind") != "gig" and FREELANCE.search(f"{j.get('employment_type', '')} {j.get('title', '')}"):
            j["kind"] = "gig"
    # Dedupe the same posting seen through several sources/terms.
    seen, unique = set(), []
    for j in jobs:
        key = (j["id"],)
        soft = (re.sub(r"\W", "", j["company"].lower()), re.sub(r"\W", "", j["title"].lower()))
        if key in seen or soft in seen:
            continue
        seen.update({key, soft})
        unique.append(j)
    return unique
