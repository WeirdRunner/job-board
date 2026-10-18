"""Benchmark v2: more candidates, more matching jobs, and only postings the trained models never saw.

Six candidates: the board owner, two training personas, and three held-out ones invented here (never in any
training data). Per candidate 30 postings (12 whose titles look like a fit, 18 at random) + 60 titles for triage,
drawn from corpus postings that were never labelled for training (and whose title + company never was either).
Gold labels are written by hand (bench/v2/GUIDE.md) and are used only to evaluate, never to train.

    ../.venv/bin/python bench/v2/make_set.py      # -> bench/v2/set.json

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
from sysone.personas import PERSONAS, _p  # noqa: E402

HELD_OUT = [
    _p("ML Engineer · PyTorch · NLP", "An entry-level ML or NLP engineering role I can do remotely.", "entry",
       "Nigeria", "Ibadan, Nigeria", ["ai_ml_engineering", "applied_ai_products"],
       ["Python", "PyTorch", "Hugging Face", "NLP", "scikit-learn", "FastAPI", "Docker", "SQL"],
       {"YorubaNER": "Named-entity recognition for Yoruba news text", "Ask-the-Docs": "RAG chatbot over university handbooks"},
       "Computer science graduate; one year as a junior data scientist at a Lagos fintech.", ("English", "Yoruba")),
    _p("Senior Full Stack Engineer · TypeScript · Python", "A senior product-engineering role, remote in the EU or in Warsaw.",
       "senior", "Poland", "Warsaw, Poland", ["full_stack", "backend", "frontend"],
       ["TypeScript", "React", "Next.js", "Node.js", "Python", "Django", "PostgreSQL", "AWS", "GraphQL", "Docker"],
       {"Ledgerly": "Accounting SaaS used by 4k small businesses", "FormKit": "Open-source form builder (2k GitHub stars)"},
       "Seven years building B2B SaaS products end to end.", ("Polish", "English")),
    _p("DevOps Engineer · AWS · Kubernetes", "A mid-level DevOps or SRE role, remote or in Manila.", "mid",
       "Philippines", "Manila, Philippines", ["devops_platform"],
       ["AWS", "Kubernetes", "Terraform", "Docker", "Linux", "Bash", "Python", "Prometheus", "Grafana", "GitHub Actions"],
       {"ClusterOps": "Migrated 40 services to EKS", "CostWatch": "AWS cost anomaly alerts"},
       "Three years as a cloud engineer at a BPO technology team.", ("English", "Filipino")),
]
FIT_WORDS = {
    "ai_ml_engineering": r"machine learning|\bml\b|\bai\b|llm|nlp|deep learning|mlops",
    "applied_ai_products": r"\bai\b|llm|genai|generative|agent",
    "full_stack": r"full[- ]?stack|software engineer|product engineer",
    "frontend": r"front[- ]?end|react|ui engineer",
    "backend": r"back[- ]?end|java|golang|\bgo\b|python|api|platform engineer|software engineer",
    "data_engineering": r"data engineer|analytics engineer|etl|data platform",
    "devops_platform": r"devops|\bsre\b|site reliability|platform|cloud engineer|infrastructure",
    "data_science": r"data scien|data analyst|analytics",
}


def main():
    rng = random.Random(7)
    from bench.run import candidate
    owner = candidate()
    cands = [("owner", owner), ("train_backend_india", PERSONAS[0]), ("train_data_eng_germany", PERSONAS[3])] + \
            [(f"heldout_{n}", p) for n, p in zip(["ml_nigeria", "fullstack_poland", "devops_philippines"], HELD_OUT)]
    seen_ids, seen_tc = set(), set()
    posts = {}
    for l in open(ROOT / "data/corpus/postings.jsonl"):
        j = json.loads(l)
        posts[j["id"]] = j
    for f in glob.glob(str(ROOT / "data/corpus/labels/*.jsonl")):
        for l in open(f):
            r = json.loads(l)
            if r["kind"] == "eval":
                jid = r["key"].split(":", 1)[1]
                seen_ids.add(jid)
                if jid in posts:
                    seen_tc.add((posts[jid]["title"].lower(), posts[jid]["company"].lower()))
    v1 = json.loads((ROOT / "bench/set.json").read_text())
    seen_ids |= {j["id"] for j in v1["jobs"]} | {t["id"] for t in v1["titles"]}
    pool = [j for j in posts.values() if j["id"] not in seen_ids and (j["title"].lower(), j["company"].lower()) not in seen_tc
            and len(j.get("description") or "") > 400]
    rng.shuffle(pool)
    used = set()
    out = {"candidates": {}, "jobs": [], "titles": []}
    fieldname = {v: k for k, v in FIELDS.items()}
    for name, c in cands:
        out["candidates"][name] = c
        fields = [fieldname.get(f, f) for f in c["fields"]]
        rx = re.compile("|".join(FIT_WORDS[f] for f in fields if f in FIT_WORDS) or "$^", re.I)
        fit = [j for j in pool if j["id"] not in used and rx.search(j["title"])][:12]
        used |= {j["id"] for j in fit}
        rest = [j for j in pool if j["id"] not in used][:18]
        used |= {j["id"] for j in rest}
        for j in fit + rest:
            out["jobs"].append({"id": f"{name}:{j['id']}", "candidate": name, "url": j["url"], "state": job_state(j)})
        tit = [j for j in pool if j["id"] not in used]
        tfit = [j for j in tit if rx.search(j["title"])][:25]
        tother = [j for j in tit if not rx.search(j["title"])][:35]
        used |= {j["id"] for j in tfit + tother}
        batch = tfit + tother
        rng.shuffle(batch)
        out["titles"] += [{"id": f"{name}:{j['id']}", "candidate": name, "title": j["title"], "company": j["company"]} for j in batch]
    (Path(__file__).parent / "set.json").write_text(json.dumps(out, indent=1))
    print(len(out["jobs"]), "jobs,", len(out["titles"]), "titles, pool", len(pool))


if __name__ == "__main__":
    main()
