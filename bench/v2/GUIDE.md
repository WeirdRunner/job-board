# Labelling guide: benchmark v2

Gold labels say what a careful human would answer after reading the whole posting. They're used only to score
engines, never to train a model. Read every posting in full; don't guess from the title. If the posting genuinely
doesn't say, use `null` (left unlabelled) rather than a guess. Each label must follow the option definitions the
board asks engines (copied below), so a correct engine answer and the gold label mean the same thing.

## Per job (`jobs`): one object per job id

| key | values | meaning |
|---|---|---|
| `tech` | true / false | A hands-on technical individual-contributor role (engineering, data, ML, research) rather than sales, recruiting, marketing, support, design, product/program management or pure people management. Solutions/sales engineers: false unless the posting is mostly building software. |
| `field` | one of the fields below, or null | The field the role belongs to. |
| `level` | `internship`, `entry`, `mid`, `senior`, `staff_plus`, or null | The level the job hires for: entry ≈ 0–2 years / junior / new grad / associate / SDE-1; mid ≈ 2–5 years / SDE-2; senior ≈ 5+ years or "Senior"/"Lead" IC; staff_plus = staff, principal, architect, engineering manager, director, head. Use the title first, then stated years. null if neither says. |
| `location` | `remote_open`, `local_office`, `restricted`, `unclear` | Could **this candidate** (who lives in their `country` and is authorized to work only there) be hired without moving country? remote_open = remote and open worldwide or explicitly including their country/region; local_office = onsite/hybrid at an office in their country; restricted = requires living in, relocating to, or work authorization for somewhere else (US-only, EU-only, a city abroad, a time zone that excludes them, "must be based in X"); unclear = the posting doesn't say where the employee must be. A remote role "in the US" or "US time zones only" is restricted for a non-US candidate. |
| `eligible` | true / false / null | true iff location is remote_open or local_office for this candidate. null when location is unclear. |
| `experience` | `not_stated`, `0_2`, `2_4`, `4_7`, `7_plus` | The minimum professional experience asked for (the lowest number if a range, e.g. "3–5 years" → 2_4; "5+" → 4_7; "8+" → 7_plus). |
| `work_mode` | `remote`, `hybrid`, `onsite`, `unclear` | Where the work is done. |
| `employment` | `full_time`, `contract`, `part_time`, `internship`, or null | Only label when the posting states it (or it's an internship). |
| `degree` | `none_stated`, `any_degree_or_equivalent`, `cs_engineering_degree`, `advanced_degree`, or null | Only label when the posting is clear. "BS in CS or equivalent experience" → any_degree_or_equivalent. "Required: BS/MS in CS, EE or related" → cs_engineering_degree. PhD/MS required → advanced_degree. "Preferred" degrees don't count as required. |
| `red_flags` | true / false | Signs of a scam, unpaid, commission-only, pay-to-apply/training fee, or a vague posting with no real role (talent pools, "general application"). |
| `other_language` | true / false | The job requires working in a language the candidate doesn't list in `languages` (or the posting itself is written in another language). |
| `skill` | 0–4 | How well the candidate's `skills` and `projects` cover the job's core technical requirements: 0 different domain, almost none apply; 1 a few appear but the main ones are missing; 2 about half; 3 most, with one or two important gaps; 4 nearly every core skill. For non-technical roles use 0 unless the candidate is non-technical too. |
| `relevant` | true / false | Should this posting be on this candidate's board? true only if ALL hold: the role is in or right next to one of the candidate's `fields`; the level is at most one step above the candidate's (entry → internship/entry/mid where the years asked are ≤ 3; mid → entry/mid/senior with ≤ 5 years; senior → mid/senior/staff_plus; staff_plus → senior/staff_plus; internship → internship/entry); the candidate is eligible (location remote_open or local_office; unclear counts as not relevant unless the posting strongly implies their country); no other_language barrier; no red flags; skill ≥ 2. |

Fields: `ai_ml_engineering` (building, training, evaluating or serving ML/LLM models; ML infra; MLOps),
`applied_ai_products` (products or agents built on LLMs/AI APIs: RAG, chatbots, agent tooling, AI features),
`data_science` (statistics, analytics, experimentation, forecasting, insights), `data_engineering` (pipelines,
ETL, warehouses, streaming, large-scale scraping), `backend` (server-side services, APIs, databases),
`full_stack` (product engineering across frontend and backend), `frontend` (web UI: React, TypeScript, CSS),
`devops_platform` (cloud infra, CI/CD, Kubernetes, SRE, developer platforms), `research` (research scientist roles
centred on publishing or novel research), `other_engineering` (mobile, embedded, QA, security, other specialties),
`non_engineering` (sales, marketing, recruiting, legal, finance, operations, design, support, product/program
management).

## Per title (`titles`): judged from the title and company only

| key | values | meaning |
|---|---|---|
| `field` | true / false / null | Judging only by the title, is the role in one of the candidate's `fields`? |
| `above` | true / false / null | Does the title explicitly name a level above the candidate's `level` (e.g. Senior, Staff, Principal, Lead, Manager, Director, Head, "II/III" when the candidate is entry)? For a senior candidate, "Senior" is not above; Staff/Principal/Director are. For a staff_plus candidate almost nothing is above. |

## Output

Write a JSON file: `{"jobs": {"<job id>": {...all job keys...}}, "titles": {"<title id>": {"field": ..., "above": ...}}}`.
Every job id and title id from your item file must appear. Keep a one-line `"note"` in a job's object only when a
label was a hard call.
