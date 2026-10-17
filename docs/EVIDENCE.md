# Why the board has Proof, People and Plan

The job board started as "find relevant postings". Applications alone produced almost nothing (35 cold applications, 0
interviews), so we looked for what research says actually changes the odds for an early-career candidate without a
CS degree. The standard follows [hiring-evidence-audit.pages.dev](https://hiring-evidence-audit.pages.dev/):
randomized experiments, audit studies and peer-reviewed work first, and vendor statistics left out or flagged.

## What the evidence supports, and what we built from it

| Feature | What it does | Evidence |
|---|---|---|
| **Proof** (Profile → What employers see; on every card) | Proof only counts where a reviewer looks, so nothing is entered on the board. It reads the projects linked in your resume and checks what a reviewer would find on GitHub: dead or redirected links, a README that states a measured result and how to run it, tests/CI, pins, a live demo. Each gap comes with paste-ready text (README sections, a LinkedIn Projects entry). Job cards show which of a job's skills your projects show; the most-asked skills they don't show get an honest next step (a proctored test that exists, a small real change, or drop the claim). | Public skill-assessment reports raised employment 17% and interview invitations 11%, most for people with no degree or work history ([Carranza et al. 2022, *AER*](https://www.aeaweb.org/articles?id=10.1257/aer.20200961)). Nudging Coursera certificate holders without degrees to post them on LinkedIn raised new jobs 6% ([Athey & Palikot 2024, preprint](https://arxiv.org/abs/2405.00247)). Verified history helped applicants from less developed countries most ([Agrawal, Lacetera & Lyons 2016](https://www.nber.org/papers/w18720)). Only *credible* signals count: perfect-score reference letters had no effect ([Abel, Burger & Piraino 2020](https://doi.org/10.1257/app.20180666)). |
| **People** (Reach out, on cards and tracker rows) | Contacts the posting itself publishes; searches you open yourself (engineers, managers/founders, your alumni, recruiters at that company); a draft built from your best proof for that job; a log of who you messaged, follow-ups (at most two) and replies. Nothing is scraped and nothing is sent for you. | Moderately weak ties produced the most job moves in a 20M-user LinkedIn experiment ([Rajkumar et al. 2022, *Science*](https://www.science.org/doi/10.1126/science.abl4476)). Referred applicants were 7.3 points more likely to be interviewed ([Brown, Setren & Topa 2016](https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr568.pdf)), a real but far smaller edge than vendor "11×" claims. LinkedIn training raised employment 7 points in an RCT ([Wheeler et al. 2022](https://www.aeaweb.org/articles?id=10.1257/app.20200025)). |
| **Plan** (Tracker → This week) | A written weekly plan (applications, people to message, focus) shown against what you actually did, follow-ups due, and an honest odds line. No reminders. | A written job-search plan led to ~30% more offers and 26% higher employment; reminders and peer support added nothing ([Abel, Burger, Carranza & Piraino 2019](https://doi.org/10.1257/app.20170566)). The odds line uses the 4.7% average callback rate for applicants with little experience ([Kroft, Lange & Notowidigdo 2013](https://www.povertyactionlab.org/evaluation/dependence-duration-and-labor-market-conditions-evidence-united-states)); job seekers' beliefs stay over-optimistic ([Mueller, Spinnewijn & Topa 2021](https://doi.org/10.1257/aer.20190808)). |
| **Gigs** (Jobs/Gigs filter) | Freelance projects in the same deck and tracker. | A first job plus a public rating took inexperienced workers' employment from 12% to 30% ([Pallais 2014, *AER*](https://www.nber.org/papers/w18917)). We found no credible study showing freelancing leads to later salaried jobs; the benefit is the track record. |

## Deliberately not built

- **Auto-apply and mass messaging.** No evidence of benefit; against most sites' terms.
- **An AI cover letter for every job.** Tailored proposals lost most of their signal once LLMs made them cheap
  ([Galdin & Silbert 2025](https://arxiv.org/abs/2511.08785); Cui, Dias & Ye 2025). Drafts here are a starting point
  anchored to *your* proof, with [brackets] you must fill.
- **"ATS score" meters.** "75% of resumes are rejected by ATS" traces to a 2012 sales pitch with no published method.
- **"Apply in the first hour" alerts.** No study isolates application timing; the popular figures come from vendors.
- **Streaks and nagging reminders.** Reminders added nothing beyond a plan (Abel et al. 2019).
- **Re-running resume rewrites.** AI writing help raised hires about 8% once ([Wiles, Munyikwa & Horton 2025](https://arxiv.org/abs/2301.08083)); it is a one-time gain.

None of these studies is from Indian tech hiring; the closest are South Africa, Ethiopia, Uganda, Coursera learners in
developing countries, and online labour markets. Treat effect sizes as direction and rough magnitude, not promises.
