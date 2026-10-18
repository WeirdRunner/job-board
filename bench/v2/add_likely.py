"""Benchmark v2, part B: postings each candidate could plausibly be hired for, so the board's precision AND recall
can be measured (part A, from the big-company corpus, turned out to hold almost no eligible matches).

Per candidate: 20 postings whose title fits their fields, whose location names their country, their region or
"worldwide", and whose title isn't far above their level; plus 5 hard negatives (fitting title and location, but a
level well above theirs). Drawn from postings fetched fresh on 2026-10-17 (data/corpus/fresh-2026-10-17.json)
and from corpus postings never used for training. Appends to bench/v2/set.json with ids "<candidate>:B:<job id>".

(Kept to document how the set was built; it needs the training code in sysone/, which isn't published. set.json and
labels/ are the benchmark.)
"""
import glob
import json
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app.pipeline import job_state  # noqa: E402
from app.questions import FIELDS  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
from make_set import FIT_WORDS  # noqa: E402

GEO = {
    "India": r"india|bengaluru|bangalore|delhi|gurgaon|gurugram|noida|mumbai|pune|hyderabad|chennai|apac|asia",
    "Nigeria": r"nigeria|lagos|africa|emea",
    "Poland": r"poland|warsaw|krak|wroc|europe|\beu\b|emea|\bcet\b",
    "Philippines": r"philippines|manila|apac|asia",
    "Germany": r"germany|deutschland|berlin|munich|münchen|hamburg|europe|\beu\b|emea|\bcet\b",
}
WORLD = r"worldwide|anywhere|global|remote$"
TOO_HIGH = {"entry": r"senior|\bsr\b|staff|principal|lead|manager|director|head|architect|\biii\b",
            "mid": r"staff|principal|director|head|vp|chief", "senior": r"director|head|vp|chief"}


def main():
    rng = random.Random(11)
    path = Path(__file__).parent / "set.json"
    s = json.loads(path.read_text())
    if any(":B:" in j["id"] for j in s["jobs"]):
        sys.exit("part B already added")
    seen = set()
    posts = {}
    for l in open(ROOT / "data/corpus/postings.jsonl"):
        j = json.loads(l)
        posts[j["id"]] = j
    tc = lambda j: (re.sub(r"\W", "", j["title"].lower()), re.sub(r"\W", "", j["company"].lower()))
    for f in glob.glob(str(ROOT / "data/corpus/labels/*.jsonl")):
        for l in open(f):
            r = json.loads(l)
            if r["kind"] == "eval":
                jid = r["key"].split(":", 1)[1]
                seen.add(jid)
                if jid in posts:
                    seen.add(tc(posts[jid]))
    v1 = json.loads((ROOT / "bench/set.json").read_text())
    seen |= {j["id"] for j in v1["jobs"]} | {x["id"].split(":")[-1] for x in s["jobs"] + s["titles"]}
    fresh = json.loads((ROOT / "data/corpus/fresh-2026-10-17.json").read_text())
    pool = [j for j in fresh + list(posts.values())
            if j["id"] not in seen and tc(j) not in seen and len(j.get("description") or "") > 400]
    rng.shuffle(pool)
    fieldname = {v: k for k, v in FIELDS.items()}
    used = set()
    for name, c in s["candidates"].items():
        fields = [fieldname.get(f, f) for f in c["fields"]]
        fit = re.compile("|".join(FIT_WORDS[f] for f in fields if f in FIT_WORDS), re.I)
        geo = re.compile(GEO.get(c["country"], re.escape(c["country"])) + "|" + WORLD, re.I)
        high = re.compile(TOO_HIGH.get(c["level"], r"$^"), re.I)
        ok = [j for j in pool if j["id"] not in used and fit.search(j["title"])
              and geo.search(f"{j['location']} {j.get('location_restrictions') or ''}".strip())]
        likely = [j for j in ok if not high.search(j["title"])][:20]
        hard = [j for j in ok if high.search(j["title"]) and j not in likely][:5]
        used |= {j["id"] for j in likely + hard}
        for j in likely + hard:
            s["jobs"].append({"id": f"{name}:B:{j['id']}", "candidate": name, "url": j.get("url"), "state": job_state(j)})
        print(name, len(likely), "likely +", len(hard), "hard negatives")
    path.write_text(json.dumps(s, indent=1))


if __name__ == "__main__":
    main()
