/* Proof, people and plan: the parts of a job search that research says move the odds (docs/EVIDENCE.md).
 *
 *  1. Proof   — what an employer actually sees when they follow your resume's links. Projects come from the resume
 *               itself; each one is checked the way a reviewer would (public repo? description? a README that states
 *               a measured result and how to run it? tests/CI? working demo? pinned? on LinkedIn?) with a concrete fix
 *               for every gap. Credible, checkable signals are what moved hiring in the experiments (Carranza et al.
 *               2022; Athey & Palikot 2024; Abel et al. 2020); a list inside this app proves nothing to anyone.
 *  2. People  — who to reach at a company: contacts the posting publishes, searches you open yourself, a draft that
 *               leads with your best proof for that job, and a log on the tracker row (Rajkumar et al. 2022).
 *  3. Plan    — a written weekly plan against what you actually did; no reminders (Abel et al. 2019).
 *
 * Uses app.js globals (esc, api, toast, $, skillTerms, refreshStatus, STATIC_MODE) at call time.
 */
const Outreach = (() => {
  let ctx = null;              // { profile, links, projects, extras, state } — from the profile and the resume's LaTeX
  const uid = () => Math.random().toString(36).slice(2, 10);
  const lc = (s) => String(s || "").toLowerCase();
  const enc = encodeURIComponent;
  const today = () => new Date().toISOString().slice(0, 10);
  const copyBtn = (text, label = "Copy") => `<button class="btn tiny" data-copy="${esc(text)}">${label}</button>`;

  // ---------------------------------------------------------------- the resume's own projects
  function groups(src, i, n) {                      // the next n balanced {…} groups from position i
    const out = [];
    let j = i;
    while (out.length < n) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== "{") break;
      let d = 0, k = j;
      for (; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && !--d) break; }
      out.push(src.slice(j + 1, k));
      j = k + 1;
    }
    return { out, end: j };
  }
  const hrefs = (s) => [...s.matchAll(/\\href\{([^}]*)\}/g)].map((m) => m[1]);
  const detex = (s) => s.replace(/\\href\{[^}]*\}/g, "").replace(/\$\\cdot\$/g, "·").replace(/\$\\sim\$/g, "~")
    .replace(/\\%/g, "%").replace(/\\&/g, "&").replace(/\\_/g, "_").replace(/\\(?:textit|textbf|texttt|emph|small|bf|hfill)\b\s*/g, "")
    .replace(/\\[a-zA-Z]+\*?/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  // A measured result: a number with a unit, next to a word that says what was measured. "3B" in a model's name or
  // "95% confident" is not a result; "96% accuracy", "0.15 s per job" and "81 tests in CI" are.
  const QTY = /\d[\d,.]*\s?(%|x\b|×|ms\b|s\b|sec\b|seconds?|k\b|tokens|tests|users|requests|pp\b|points)/gi;
  const METRIC = /accura|\bf1\b|precision|recall|latency|throughput|faster|slower|speed|benchmark|scor|\beval|\btests?\b|pass|error|loss|win rate|per (job|posting|request|second|token|item|call)|\/s\b|reduc|improv|users|downloads|uptime|ci\b/i;
  const COUNTED = /\d[\d,]*\s(?:[a-z-]+\s)?(tests|users|requests|downloads|stars)\b/i;          // "81 backend tests"
  const NAMED = /(accuracy|f1|precision|recall|score|latency|throughput|win rate|error rate)\W{0,12}[^\n\d]{0,30}\d/i;   // tables
  const hasResult = (text) => { text = String(text || "");
    return COUNTED.test(text) || NAMED.test(text) || [...text.matchAll(QTY)]
      .some((m) => METRIC.test(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60))); };

  function projectsFromTex(tex) {
    const body = tex.slice(Math.max(0, tex.indexOf("\\begin{document}")));
    const out = [];
    let at = 0;
    while ((at = body.indexOf("\\entryheader", at)) !== -1) {
      const { out: a, end } = groups(body, at + "\\entryheader".length, 3);
      at = end;
      const stops = [body.indexOf("\\entryheader", end), body.indexOf("\\section", end)].filter((x) => x > 0);
      const chunk = body.slice(end, stops.length ? Math.min(...stops) : body.length);
      const items = chunk.split("\\item").slice(1).map((x) => x.replace(/\\end\{tightitemize\}[\s\S]*$/, ""));
      const head = a[0] || "", urls = hrefs(head);
      if (!urls.length && items.some((it) => hrefs(it).length)) {        // a job: each linked bullet is a project
        for (const it of items) {
          const u = hrefs(it);
          if (!u.length) continue;
          const t = detex(it), [nm, ...rest] = t.split(":");
          out.push({ name: nm.trim(), urls: u, desc: rest.join(":").trim(), stack: "", bullets: [rest.join(":").trim() || t], where: detex(head) });
        }
        continue;
      }
      if (!urls.length) continue;                                          // education and the like
      const title = detex(head);
      out.push({ name: title.split(" - ")[0].trim(), urls, desc: title.split(" - ").slice(1).join(" - ").trim(),
                 stack: detex(a[2] || ""), bullets: items.map(detex).filter(Boolean) });
    }
    return out;
  }

  const repoOf = (urls) => {
    for (const u of urls || []) {
      const m = u.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
      if (m && !/^(orgs|users|settings)$/i.test(m[1])) return { owner: m[1], name: m[2], url: u };
    }
    return null;
  };
  const liveOf = (urls) => (urls || []).find((u) => /^https?:/.test(u) && !/github\.com|linkedin\.com|mailto:|tel:/i.test(u));

  async function load(force = false) {
    if (ctx && !force) return ctx;
    const profile = (await api("/api/profile").catch(() => null)) || {};
    const tex = (await api("/api/resume").catch(() => null))?.tex || "";
    const projects = tex ? projectsFromTex(tex) : [];
    const ghProfile = (tex.match(/https?:\/\/(?:www\.)?github\.com\/([\w-]+)\/?(?=[}\s])/) || [])[0] || "";
    const links = {
      github: profile.github || ghProfile, resumeGithub: ghProfile,
      linkedin: profile.linkedin || (tex.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/) || [""])[0],
      // The university first: a wider alumni network than a single college.
      school: profile.school || (tex.match(/University of [A-Z]\w+(?: [A-Z]\w+)?|[A-Z][\w.]+(?: [A-Z][\w.]+)* (?:University|Institute of Technology)/)
        || tex.match(/[A-Z][\w.]+(?: [A-Z][\w.]+)* College/) || [""])[0],
    };
    ctx = { profile, links, projects, extras: profile.proofs || [], state: profile.proof_state || {}, hasTex: !!tex };
    return ctx;
  }

  // ---------------------------------------------------------------- what GitHub shows a reviewer (cached 6 h)
  const AUDIT_KEY = "proof-audit-v1";
  const readAudit = () => { try { return JSON.parse(localStorage.getItem(AUDIT_KEY) || "null"); } catch (_) { return null; } };
  async function ghGet(path) {
    // Through the board's GitHub token when it has one (5,000 calls/hour); anonymous calls get only 60.
    try { return await api(`/api/proof/gh?path=${enc(path)}`); }
    catch (e) {
      if (/^not found$/i.test(e.message)) return null;
      if (!/no github token/i.test(e.message)) throw e;
    }
    const r = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 404) return null;
    if (r.status === 403 || r.status === 429) throw new Error("GitHub's hourly limit for anonymous checks was reached — try again in an hour.");
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.json();
  }
  const b64text = (b) => new TextDecoder().decode(Uint8Array.from(atob((b || "").replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  async function reachable(url) {
    try { await fetch(url, { mode: "no-cors", cache: "no-store" }); return true; } catch (_) { return false; }
  }

  async function audit(force = false) {
    await load();
    const cached = readAudit();
    if (!force && cached && Date.now() - cached.at < 6 * 3600e3) return cached;
    const login = (ctx.links.github.match(/github\.com\/([\w-]+)/) || [])[1];
    const resumeLogin = (ctx.links.resumeGithub.match(/github\.com\/([\w-]+)/) || [])[1];
    const user = login ? await ghGet(`/users/${login}`) : null;
    const resumeUser = resumeLogin && lc(resumeLogin) !== lc(login) ? await ghGet(`/users/${resumeLogin}`) : user;
    const repos = user ? await ghGet(`/users/${user.login}/repos?per_page=100&sort=pushed`) || [] : [];
    let pinned = null;
    if (user) pinned = await api(`/api/proof/pinned?login=${enc(user.login)}`).catch(() => null);
    const out = { at: Date.now(), login: user?.login || null, bio: user?.bio || "", location: user?.location || "",
      resumeLink: { url: ctx.links.resumeGithub, ok: !!resumeUser || !ctx.links.resumeGithub }, pinned, repos: [], projects: {} };
    for (const p of ctx.projects) {
      const rp = repoOf(p.urls), live = liveOf(p.urls);
      const a = { name: p.name, repoUrl: rp?.url || null, live: live || null };
      if (rp) {
        const r = await ghGet(`/repos/${rp.owner}/${rp.name}`);
        if (r) {
          const [readme, tree, langs] = await Promise.all([
            ghGet(`/repos/${r.full_name}/readme`).catch(() => null),
            ghGet(`/repos/${r.full_name}/git/trees/${r.default_branch}?recursive=1`).catch(() => null),
            ghGet(`/repos/${r.full_name}/languages`).catch(() => null)]);
          const paths = (tree?.tree || []).map((t) => t.path);
          const workflows = paths.some((x) => /^\.github\/workflows\/.+\.ya?ml$/.test(x));
          const runs = workflows ? await ghGet(`/repos/${r.full_name}/actions/runs?per_page=1&branch=${enc(r.default_branch)}`).catch(() => null) : null;
          const text = readme ? b64text(readme.content) : "";
          a.repo = { full: r.full_name, html: r.html_url, description: r.description || "", homepage: r.homepage || "",
            pushed: r.pushed_at, moved: lc(r.owner.login) !== lc(rp.owner), languages: Object.keys(langs || {}),
            readmeResult: hasResult(text),
            readmeRun: /```|pip install|npm (?:i|install|run)|## *(run|quick ?start|usage|getting started|setup)/i.test(text),
            readmeText: text.slice(0, 20000),
            tests: paths.some((x) => /(^|\/)(tests?|__tests__)\//.test(x) || /(^|\/)test_[^/]+\.py$|\.(test|spec)\.[jt]sx?$|_test\.go$/.test(x)),
            workflows, ci: runs?.workflow_runs?.[0]?.conclusion || null };
        } else a.repo = null;
      }
      const demo = live || a.repo?.homepage;
      if (demo) a.demoOk = await reachable(demo);
      out.projects[p.name] = a;
    }
    const onResume = new Set(Object.values(out.projects).map((a) => lc(a.repo?.full || "")));
    out.repos = repos.filter((r) => !r.fork && !onResume.has(lc(r.full_name)) && lc(r.name) !== lc(r.owner.login))
      .map((r) => ({ name: r.name, html: r.html_url, description: r.description || "", pushed: r.pushed_at }));
    try { localStorage.setItem(AUDIT_KEY, JSON.stringify(out)); } catch (_) { /* storage off */ }
    return out;
  }

  // One project, judged like a reviewer who clicks the link from your resume.
  function checksFor(p, a, au) {
    const r = a?.repo, out = [], add = (ok, label, fix = "", copy = "") => out.push({ ok, label, fix, copy });
    const numeric = p.bullets.filter(hasResult);
    add(!!(a?.repoUrl || a?.live), "Linked from your resume", "Put the repo (or demo) link in this project's heading in your resume — reviewers won't search for it.");
    if (a?.repoUrl) {
      if (r === null) add(false, "Repo opens", "The link 404s or the repo is private — make it public or fix the link.");
      else if (r) {
        add(r.moved ? "warn" : true, r.moved ? "Repo opens (only through a redirect from an old username)" : "Repo opens",
            r.moved ? `Update the link in your resume to ${r.html}.` : "");
        add(!!r.description, "Has a one-line description", "Add one under the repo's About ⚙ — it shows in search and on your profile.",
            p.desc || p.bullets[0] || "");
        add(r.readmeResult, "README states a measured result",
            "Reviewers skim the README for one number — accuracy, speed, size, tests passing. Add a short Results section.",
            numeric.length ? `## Results\n\n${numeric.map((b) => `- ${b}`).join("\n")}\n` : "## Results\n\n- [What you measured]: [number] ([how you measured it])\n");
        add(r.readmeRun, "README says how to run it", "Add a Quick start with the two or three commands that run it.",
            "## Quick start\n\n```bash\n[install command]\n[run command]\n```\n");
        if (r.workflows) add(r.ci === "success" ? true : r.ci ? false : "warn",
          r.ci === "success" ? "CI passing" : r.ci ? `CI is ${r.ci}` : "CI configured (no runs yet)",
          r.ci && r.ci !== "success" ? "A red CI run is worse than none — fix it or remove the workflow." : "");
        else add(r.tests ? "warn" : false, r.tests ? "Has tests (but no CI running them)" : "Has tests",
          r.tests ? "Add a GitHub Actions workflow that runs them — a green check is something a stranger can verify."
                  : "Even a few tests and a CI workflow make the claims checkable.");
        if (au.pinned) add(au.pinned.some((n) => lc(n) === lc(r.full.split("/")[1])), "Pinned on your GitHub profile",
          "Pin it: your profile → Customize your pins.");
      }
    }
    if (a?.live || r?.homepage) add(a.demoOk ? true : false, "Live demo opens", "The demo link doesn't load — fix it or remove it.");
    add(numeric.length ? true : "warn", "Your resume states a measured result for it", "Add one to its bullets: accuracy, speed, tests passing — something a reviewer can check.");
    const st = ctx.state[p.name] || {};
    add(st.linkedin ? true : "warn", "On your LinkedIn (Projects or Featured)", "Add it — paste-ready text below.");
    return out;
  }
  const scoreOf = (cs) => cs.reduce((n, c) => n + (c.ok === true ? 1 : c.ok === "warn" ? 0.5 : 0), 0) / Math.max(1, cs.length);

  // ---------------------------------------------------------------- proof for a job
  const textOf = (p, a) => [p.name, p.desc, p.stack, ...p.bullets, ...(a?.repo?.languages || []), (a?.repo?.readmeText || "").slice(0, 6000)].join(" ");
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function mentions(text, skill) {
    return skillTerms([skill]).some((t) => t.length <= 2
      ? new RegExp(`(^|[^A-Za-z])${reEsc(t)}([^A-Za-z]|$)`).test(text)
      : new RegExp(`(^|[^a-z0-9])${reEsc(lc(t))}([^a-z0-9]|$)`).test(lc(text)));
  }
  function proofs() {
    const au = readAudit() || { projects: {} };
    const fromResume = (ctx?.projects || []).map((p) => {
      const a = au.projects?.[p.name];
      return { title: p.name, url: a?.repo?.html || a?.live || p.urls[0], text: textOf(p, a),
               note: p.bullets.find(hasResult) || "", weak: !!(a?.repo && !a.repo.readmeResult) };
    });
    const added = (ctx?.extras || []).map((x) => ({ title: x.title, url: x.url, text: [x.title, ...(x.skills || []), x.note || ""].join(" "), note: x.note || "" }));
    return [...fromResume, ...added];
  }
  function proofFor(job) {
    const c = job.card || {}, all = proofs();
    const have = new Set((ctx?.profile?.keywords || []).filter((k) => k.keep).map((k) => lc(k.name)));
    const required = [...new Set([...(c.skills_matched || []), ...(c.skills_gap || [])])];
    const out = { proven: [], claimed: [], missing: [], best: [] };
    for (const s of required) {
      const p = all.find((x) => mentions(x.text, s));
      if (p) out.proven.push({ skill: s, proof: p });
      else if ((c.skills_matched || []).includes(s) || have.has(lc(s))) out.claimed.push(s);
      else out.missing.push(s);
    }
    out.best = all.map((p) => ({ p, n: required.filter((s) => mentions(p.text, s)).length }))
      .filter((x) => x.n).sort((a, b) => b.n - a.n || Number(a.p.weak) - Number(b.p.weak)).slice(0, 2).map((x) => x.p);
    return out;
  }

  // ---------------------------------------------------------------- skills to prove next (honest options only)
  const HACKERRANK = /^(python|sql|javascript|react|java|problem solving|css|node(\.js)?|rest api|go|c#|angular)$/i;
  function nextStep(skill) {
    const s = lc(skill);
    if (HACKERRANK.test(skill)) return { how: "HackerRank's free, proctored skill certification covers this (about an hour); its certificate has a public verification link. Add it below and to LinkedIn.", url: "https://www.hackerrank.com/skills-verification" };
    if (/kubernetes|k8s|helm/.test(s)) return { how: "There's no free test an employer would trust. Either add a manifest plus a CI job that deploys one of your projects to a throwaway kind cluster, or drop it from your resume — a claim nobody can check invites hard interview questions." };
    if (/docker|container/.test(s)) return { how: "Add a Dockerfile to one project and a CI step that builds it — anyone can see both in the repo." };
    if (/aws|gcp|azure|cloud/.test(s)) return { how: "Deploy one project there and put the live link in its README. The providers' entry certificates are paid; a working deployment is the cheaper proof." };
    if (/ci\/cd|github actions|\bci\b/.test(s)) return { how: "Add a GitHub Actions workflow that runs your tests on every push; the green check is the proof." };
    if (/eval|benchmark|testing|pytest|jest/.test(s)) return { how: "Put an evaluation or test result in a README — a table or one line with the number." };
    return { how: "Show it in a small real change to one of your projects, with one sentence about it in the README — or drop it from your resume if you can't." };
  }

  // ---------------------------------------------------------------- people
  const ROLE_INBOX = /^(jobs?|careers?|hiring|recruit(ing|ment)?|talent|hr|people|apply|work)@/i;
  const JUNK = /noreply|no-reply|example\.|privacy@|legal@|support@|security@|sentry|wixpress|\.(png|jpg|gif)$/i;

  function fromPosting(job) {
    const text = `${job.title || ""}\n${job.description || ""}`;
    const found = [], seen = new Set();
    const snip = (i) => text.slice(Math.max(0, i - 70), i + 90).replace(/\s+/g, " ").trim();
    const add = (kind, value, label, i) => { const k = lc(value); if (!seen.has(k)) { seen.add(k); found.push({ kind, value, label, snippet: snip(i) }); } };
    for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      if (JUNK.test(m[0])) continue;
      add("email", m[0].replace(/\.$/, ""), ROLE_INBOX.test(m[0]) ? "Hiring inbox" : "Person (email in the posting)", m.index);
    }
    for (const m of text.matchAll(/https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[\w%-]+\/?/g)) add("linkedin", m[0], "LinkedIn (in the posting)", m.index);
    for (const m of text.matchAll(/https?:\/\/(?:www\.)?calendly\.com\/[\w/-]+/g)) add("link", m[0], "Booking link", m.index);
    for (const m of text.matchAll(/\b(?:reach out to|contact|email|message|ping|DM|talk to|questions\?\s*(?:ask|email))\s+(?:me,?\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/g)) {
      if (!/^(Us|Our|The|We|Me|Hiring|Recruiting|Careers|Jobs)$/.test(m[1])) add("name", m[1], "Named in the posting", m.index);
    }
    return found;
  }

  function roleOf(job) {
    let t = String(job.title || "").replace(/https?:\/\/\S+/g, "").trim();
    if (job.source === "hackernews" && t.includes("|")) {
      const parts = t.split("|").map((x) => x.trim()).filter(Boolean);
      t = parts.find((x, i) => i > 0 && /engineer|developer|scientist|analyst|designer|manager|intern|roles?|lead|architect/i.test(x)) || parts[1] || parts[0];
    }
    return t.replace(/\s{2,}/g, " ").slice(0, 80) || "the open role";
  }

  function searches(job) {
    const co = job.company || "", school = ctx?.links?.school || "";
    const roleWords = roleOf(job).replace(/\(.*?\)|[–—-].*$/g, "").trim();
    const li = (q) => `https://www.linkedin.com/search/results/people/?keywords=${enc(q)}`;
    const g = (q) => `https://www.google.com/search?q=${enc(q)}`;
    const small = /hackernews|freelancer/.test(job.source || "");
    const out = [
      { label: `Engineers at ${co}`, url: li(`${co} ${roleWords}`), why: "Peers in the team you'd join — best for a referral ask" },
      { label: small ? `Founders at ${co}` : `Engineering managers at ${co}`, url: li(`${co} ${small ? "founder" : "engineering manager"}`), why: "The person who usually decides" },
    ];
    if (school) out.push({ label: `${school} alumni at ${co}`, url: li(`${co} ${school}`), why: "Moderately weak ties — the kind that produce the most job moves (Rajkumar et al., 2022)" });
    out.push({ label: `Recruiters at ${co}`, url: li(`${co} technical recruiter`), why: "Useful once you've applied" },
             { label: `What ${co} has built or written`, url: g(`"${co}" engineering blog OR github`), why: "Read one thing first — it's your opening line" });
    return out;
  }

  // ---------------------------------------------------------------- drafts
  const TYPES = { manager: "Hiring manager / founder", engineer: "Engineer (referral ask)", alumni: "Alum",
                  recruiter: "Recruiter (after applying)", followup: "Follow-up" };

  function draft(type, job, who = "") {
    const p = ctx?.profile || {}, L = ctx?.links || {};
    const me = (p.name || "").split(" ")[0] || p.name || "";
    const first = (who || "").split(" ")[0] || "[name]";
    const pr = proofFor(job), best = pr.best[0];
    const proofLine = best ? `${best.title}${best.url ? ` (${best.url})` : ""}${best.note ? ` — ${best.note.replace(/\.$/, "")}` : ""}`
                           : "[your most relevant project, with a link and one measured result]";
    const stack = pr.proven.slice(0, 3).map((x) => x.skill);
    const stackLine = stack.length ? ` It uses ${stack.join(", ")}, which the posting asks for.` : "";
    const sign = [p.name || "", [L.github, L.linkedin].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
    const role = roleOf(job), co = job.company || "[company]";
    const T = {
      manager: `Subject: ${role} — ${best ? best.title : "a relevant project"}\n\nHi ${first},\n\n[One line about something specific they built or wrote.] I'm interested in the ${role} role at ${co}. The most relevant thing I've built: ${proofLine}.${stackLine}\n\nWould you be open to a 15-minute call, or would you rather I apply through the posting? Happy to walk through the code.\n\nThanks,\n${sign}`,
      engineer: `Hi ${first} — I'm about to apply for ${role} at ${co} and saw you work there. [One line about their work.] Could I ask you two quick questions about what the team values in new engineers?\n\nFor context, the most relevant thing I've built: ${proofLine}.${stackLine} If it looks like a fit after that, I'd be grateful for a referral — no pressure either way.\n\n${me}`,
      alumni: `Hi ${first} — fellow ${L.school || "[school]"} alum here. I'm applying for ${role} at ${co}. Would you have 10 minutes to tell me what the team looks for in new engineers?\n\nHere's what I've been building: ${proofLine}.\n\nThanks!\n${me}`,
      recruiter: `Hi ${first} — I've applied for ${role} at ${co}${job.url ? ` (${job.url})` : ""}. One thing that may help the review: ${proofLine}.${stackLine} Happy to share anything else that's useful.\n\n${sign}`,
      followup: `Hi ${first} — following up on my note about the ${role} role, in case it got buried. [If true: one new thing since — e.g. a result, a fix, a deployment.] Totally fine if now isn't a good time.\n\n${me}`,
    };
    return T[type] || T.manager;
  }

  const GUIDE = `<ul class="guide">
    <li><b>Read one thing they made first</b> (a post, repo, talk) and open with it. Fill in every [bracket] — never send one.</li>
    <li><b>One link: your best proof for this job</b> — check that page shows a result before you send it. Under 120 words. No attachments.</li>
    <li><b>Ask for something small</b> — two questions or 15 minutes, not "a job".</li>
    <li><b>Follow up once</b> after 5–7 days; stop after two follow-ups. At most two people per company per week.</li>
    <li>Send it yourself from email or LinkedIn. These drafts are a start; your own words carry the signal
      (AI-written applications lost most of their value once everyone used them: Galdin &amp; Silbert, 2025).</li>
  </ul>`;

  // ---------------------------------------------------------------- the panel (from a card or a tracker row)
  const STATUSES = { to_contact: "To contact", messaged: "Messaged", replied: "Replied", referred: "Referred", no_reply: "No reply" };
  const KINDS = { manager: "Manager / founder", engineer: "Engineer", alumni: "Alum", recruiter: "Recruiter", other: "Other" };
  const channelOf = (contacts) => contacts.some((c) => c.status === "referred") ? "referral"
    : contacts.some((c) => c.status && c.status !== "to_contact") ? "warm" : "cold";
  const daysSince = (d) => d ? Math.floor((Date.now() - new Date(d + "T00:00:00").getTime()) / 864e5) : 0;
  const followDue = (c) => c.status === "messaged" && (c.followups?.length || 0) < 2 && daysSince(c.followups?.at(-1) || c.messaged_on) >= 6;

  function proofHTML(pr) {
    if (!pr.proven.length && !pr.claimed.length && !pr.missing.length) return `<p class="faint small">This posting's skills weren't read yet.</p>`;
    const row = (cls, label, items) => items.length ? `<div class="pf-row"><span class="pf-k ${cls}">${label}</span><div>${items}</div></div>` : "";
    const b = pr.best[0];
    return `${row("good", "Your projects show", pr.proven.map((x) => `<span class="chip good" title="${esc(x.proof.title)}">${esc(x.skill)}</span>`).join(""))}
      ${row("warn", "You list it, nothing shows it", pr.claimed.map((s) => `<span class="chip warn">${esc(s)}</span>`).join(""))}
      ${row("bad", "They ask, you lack", pr.missing.map((s) => `<span class="chip bad">${esc(s)}</span>`).join(""))}
      ${b ? `<p class="small">Lead with <b>${esc(b.title)}</b>${b.url ? ` · <a href="${esc(b.url)}" target="_blank" rel="noopener">what they'll see ↗</a>` : ""}</p>
        ${b.weak ? `<p class="small due">Before you send it: its README doesn't state a result yet — see Profile → What employers see.</p>` : ""}`
        : `<p class="small faint">None of your resume's projects shows these skills.</p>`}`;
  }

  async function open({ job, row }) {
    await load();
    job = job || { title: row.role, company: row.company, url: row.url, source: row.source, description: "", card: {} };
    const pr = proofFor(job), posted = fromPosting(job);
    const box = document.createElement("div");
    box.className = "sheet-wrap";
    box.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Reach out">
      <div class="sheet-head"><div><div class="faint small">${esc(job.company)}</div><h2>${esc(roleOf(job))}</h2></div>
        <button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="sheet-body">
        <section><h3>1 · Your proof for this job</h3>${proofHTML(pr)}</section>
        <section><h3>2 · Who to reach</h3>
          ${posted.length ? `<div class="faint small">In the posting:</div><ul class="who">${posted.map((c) => `<li>
            <span class="chip ${c.kind === "email" && !ROLE_INBOX.test(c.value) ? "good" : ""}">${esc(c.label)}</span>
            ${c.kind === "email" ? `<a href="mailto:${esc(c.value)}">${esc(c.value)}</a>` : c.kind === "name" ? `<b>${esc(c.value)}</b>` : `<a href="${esc(c.value)}" target="_blank" rel="noopener">${esc(c.value.replace(/^https?:\/\//, ""))}</a>`}
            <button class="btn tiny" data-log="${esc(c.kind === "name" ? c.value : "")}" data-handle="${esc(c.kind === "name" ? "" : c.value)}">Log</button>
            <div class="faint tiny-q">“…${esc(c.snippet)}…”</div></li>`).join("")}</ul>`
            : `<p class="faint small">The posting names no one — find people yourself:</p>`}
          <ul class="who">${searches(job).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a><div class="faint small">${esc(s.why)}</div></li>`).join("")}</ul>
        </section>
        <section><h3>3 · Draft</h3>
          <div class="seg seg-sm" id="o-types">${Object.entries(TYPES).map(([k, l], i) => `<button data-type="${k}" class="${i ? "" : "active"}">${l}</button>`).join("")}</div>
          <input class="input" id="o-who" placeholder="Their name (optional)">
          <textarea class="input o-draft" id="o-draft" rows="10"></textarea>
          <div class="row-gap"><button class="btn small" id="o-copy">Copy</button><span class="faint small" id="o-words"></span></div>
          ${GUIDE}
        </section>
        <section><h3>4 · Log who you reached</h3><div id="o-log"></div>
          <form class="add-row o-add" id="o-add" autocomplete="off">
            <input class="input" name="name" placeholder="Name" required>
            <select class="input" name="kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
            <input class="input" name="handle" placeholder="Email or profile link">
            <button class="btn">Add</button></form>
          <p class="faint small">Logging saves this job to your Tracker (as “Saved” until you apply), so follow-ups and replies are counted in your week.</p>
        </section>
      </div></div>`;
    document.body.append(box);
    document.body.classList.add("modal-open");
    const $b = (s) => box.querySelector(s);
    const close = () => { box.remove(); document.body.classList.remove("modal-open"); document.removeEventListener("keydown", keys); };
    const keys = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", keys);
    box.addEventListener("click", (e) => { if (e.target === box || e.target.closest("[data-close]")) close(); });

    let type = "manager";
    const words = () => {
      const n = ($b("#o-draft").value.replace(/^Subject:.*\n/, "").match(/\S+/g) || []).length;
      const left = ($b("#o-draft").value.match(/\[[^\]]+\]/g) || []).length;
      $b("#o-words").textContent = `${n} words${n > 140 ? " — try to cut" : ""}${left ? ` · ${left} [bracket]${left > 1 ? "s" : ""} to fill` : ""}`;
    };
    const redraw = () => { $b("#o-draft").value = draft(type, job, $b("#o-who").value.trim()); words(); };
    $b("#o-types").onclick = (e) => {
      const b = e.target.closest("button[data-type]"); if (!b) return;
      type = b.dataset.type;
      $b("#o-types").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      redraw();
    };
    $b("#o-who").oninput = redraw;
    $b("#o-draft").oninput = words;
    $b("#o-copy").onclick = async () => {
      const t = $b("#o-draft").value;
      if (/\[[^\]]+\]/.test(t)) return toast("Fill in the [brackets] first — they're what makes it yours");
      await navigator.clipboard.writeText(t).catch(() => {});
      toast("Copied — send it from your own email or LinkedIn");
    };
    redraw();

    const rowFor = async () => {
      if (row) return row;
      row = await api("/api/applications", { json: { job_id: job.id, company: job.company, role: job.title, url: job.url,
        location: job.location, source: job.source, kind: job.kind || "job", match: job.match ?? job.card?.match, status: "Saved",
        channel: "cold", contacts: [] } });
      refreshStatus();
      return row;
    };
    const save = async (contacts) => {
      const r = await rowFor();
      row = await api(`/api/applications/${STATIC_MODE ? r.uid : r.id}`, { method: "PATCH", json: { contacts, channel: channelOf(contacts) } });
      if (typeof tracker !== "undefined" && tracker.rows) {
        const i = tracker.rows.findIndex((x) => x.uid === row.uid); if (i >= 0) tracker.rows[i] = row;
      }
      drawLog();
    };
    const drawLog = () => {
      const list = row?.contacts || [];
      $b("#o-log").innerHTML = list.length ? `<ul class="o-loglist">${list.map((c) => `<li data-c="${c.id}">
          <div><b>${esc(c.name)}</b> <span class="faint small">${esc(KINDS[c.kind] || "")}</span>
            ${c.handle ? (/@/.test(c.handle) && !/^https?:/.test(c.handle) ? `<a href="mailto:${esc(c.handle)}">${esc(c.handle)}</a>` : `<a href="${esc(c.handle)}" target="_blank" rel="noopener">profile ↗</a>`) : ""}</div>
          <select class="input o-st">${Object.entries(STATUSES).map(([k, l]) => `<option value="${k}" ${c.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
          <span class="faint small">${c.messaged_on ? `messaged ${esc(c.messaged_on)}` : ""}${c.followups?.length ? ` · ${c.followups.length} follow-up${c.followups.length > 1 ? "s" : ""}` : ""}${followDue(c) ? ` · <b class="due">follow-up due</b>` : ""}</span>
          ${c.status === "messaged" && (c.followups?.length || 0) < 2 ? `<button class="btn tiny o-fu">Followed up</button>` : ""}
          <button class="icon-btn o-del" aria-label="Remove">✕</button></li>`).join("")}</ul>` : `<p class="faint small">No one yet.</p>`;
      box.querySelectorAll("#o-log li").forEach((li) => {
        const id = li.dataset.c, list2 = [...(row.contacts || [])], c = list2.find((x) => x.id === id);
        li.querySelector(".o-st").onchange = (e) => {
          c.status = e.target.value;
          if (c.status === "messaged" && !c.messaged_on) c.messaged_on = today();
          save(list2);
        };
        const fu = li.querySelector(".o-fu");
        if (fu) fu.onclick = () => { c.followups = [...(c.followups || []), today()]; save(list2); };
        li.querySelector(".o-del").onclick = () => save(list2.filter((x) => x.id !== id));
      });
    };
    $b("#o-add").onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      save([...(row?.contacts || []), { id: uid(), name: f.name.value.trim(), kind: f.kind.value, handle: f.handle.value.trim(),
        status: "to_contact", messaged_on: null, followups: [], added_on: today() }]);
      f.reset();
    };
    box.querySelectorAll("[data-log]").forEach((b) => (b.onclick = () => {
      const f = $b("#o-add");
      f.name.value = b.dataset.log || (/@/.test(b.dataset.handle) ? b.dataset.handle.split("@")[0].replace(/[._]/g, " ") : "");
      f.handle.value = b.dataset.handle || "";
      f.name.focus();
    }));
    drawLog();
  }

  // A line on the job card: how many of its skills your projects show, and the button that opens the panel.
  function cardLine(job) {
    if (!ctx) return `<div class="reach-line"><span></span><button class="btn small" data-reach="${esc(job.id)}">Reach out</button></div>`;
    const pr = proofFor(job), posted = fromPosting(job).filter((c) => c.kind !== "name");
    const total = pr.proven.length + pr.claimed.length + pr.missing.length;
    return `<div class="reach-line">
      <span class="small">${total ? `Your projects show <b>${pr.proven.length}/${total}</b> of its skills` : ""}${posted.length ? `${total ? " · " : ""}<b>${posted.length}</b> contact${posted.length > 1 ? "s" : ""} in the posting` : ""}</span>
      <button class="btn small" data-reach="${esc(job.id)}">Reach out</button></div>`;
  }

  // ---------------------------------------------------------------- weekly plan (Tracker)
  function isoWeek(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 864e5 + 1) / 7)).padStart(2, "0")}`;
  }
  const weekStart = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

  function weekStats(rows) {
    const from = weekStart(), inWeek = (d) => d && d >= from;
    const applied = rows.filter((r) => r.status !== "Saved" && inWeek(r.applied_on)).length;
    let reached = 0, replies = 0, follow = 0;
    for (const r of rows) for (const c of r.contacts || []) {
      if (inWeek(c.messaged_on)) reached++;
      follow += (c.followups || []).filter(inWeek).length;
      if (["replied", "referred"].includes(c.status)) replies++;
    }
    return { applied, reached, follow, replies, due: rows.flatMap((r) => (r.contacts || []).filter(followDue).map((c) => ({ c, r }))) };
  }

  // The chance of hearing nothing back from n applications at the average callback rate for applicants with
  // little experience in Kroft, Lange & Notowidigdo (2013): 4.7%.
  function odds(rows) {
    const sent = rows.filter((r) => r.status && r.status !== "Saved" && r.status !== "Withdrawn").length;
    const heard = rows.filter((r) => ["Assessment", "Interviewing", "Offer"].includes(r.status)).length;
    return { sent, heard, none: Math.pow(1 - 0.047, sent) };
  }

  async function weekPanel(el, rows) {
    const settings = await api("/api/settings").catch(() => ({}));
    const wk = isoWeek(), plans = settings.plans || {}, plan = plans[wk] || null, s = weekStats(rows), o = odds(rows);
    const bar = (have, want) => want ? `<span class="wk-bar"><i style="width:${Math.min(100, Math.round(100 * have / want))}%"></i></span>` : "";
    el.innerHTML = `<section class="card-box week">
      <div class="wk-head"><h3 class="section-title" style="margin:0">This week <span class="faint small">${wk}</span></h3>
        <button class="btn small" id="wk-edit">${plan ? "Edit plan" : "Write this week's plan"}</button></div>
      ${plan ? `<div class="wk-grid">
          <div><div class="wk-n">${s.applied}<span>/${plan.apply || 0}</span></div><div class="faint small">applications</div>${bar(s.applied, plan.apply)}</div>
          <div><div class="wk-n">${s.reached}<span>/${plan.reach || 0}</span></div><div class="faint small">people messaged</div>${bar(s.reached, plan.reach)}</div>
          <div><div class="wk-n">${s.follow}</div><div class="faint small">follow-ups sent</div></div>
          <div><div class="wk-n">${s.replies}</div><div class="faint small">replies so far</div></div>
        </div>${plan.focus ? `<p class="small"><b>Focus:</b> ${esc(plan.focus)}</p>` : ""}`
        : `<p class="faint small">Write down how many applications and how many people you'll reach this week, and what you'll focus on.
             In a randomized trial a written plan like this led to ~30% more job offers; reminders added nothing, so this page won't nag you (Abel et al., 2019).</p>`}
      ${s.due.length ? `<p class="small">Follow-up due: ${s.due.slice(0, 4).map(({ c, r }) => `<b>${esc(c.name)}</b> (${esc(r.company)})`).join(", ")}${s.due.length > 4 ? ` +${s.due.length - 4}` : ""}</p>` : ""}
      <p class="faint small odds">${o.sent ? `${o.heard} interview${o.heard === 1 ? "" : "s"} or assessments from ${o.sent} applications. If each had a ~5% chance of a callback
        (the average for applicants with little experience in a large audit study), hearing nothing back from ${o.sent} would happen
        <b>${Math.round(o.none * 100)}%</b> of the time — so small numbers say little about you. Channels that use people and proof change the odds more than volume.` : ""}</p>
      <form class="wk-form" id="wk-form" hidden>
        <label>Applications <input class="input" type="number" min="0" max="100" name="apply" value="${plan?.apply ?? 8}"></label>
        <label>People to message <input class="input" type="number" min="0" max="50" name="reach" value="${plan?.reach ?? 5}"></label>
        <label class="grow">Focus <input class="input" name="focus" value="${esc(plan?.focus || "")}" placeholder="e.g. AI startups in Bengaluru; add a Results section to my best repo"></label>
        <button class="btn primary">Save plan</button></form>
    </section>`;
    el.querySelector("#wk-edit").onclick = () => { const f = el.querySelector("#wk-form"); f.hidden = !f.hidden; };
    el.querySelector("#wk-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const next = { ...plans, [wk]: { apply: +f.apply.value, reach: +f.reach.value, focus: f.focus.value.trim(), at: new Date().toISOString() } };
      await api("/api/settings", { method: "PATCH", json: { plans: next } });
      toast("Plan saved");
      weekPanel(el, rows);
    };
  }

  // ---------------------------------------------------------------- Profile: what employers see
  const mark = (ok) => ok === true ? `<span class="ck ok" aria-label="done">✓</span>`
    : ok === "warn" ? `<span class="ck warn" aria-label="partly">!</span>` : `<span class="ck bad" aria-label="missing">✗</span>`;

  async function proofSection(el, force = false) {
    await load(true);
    const shell = (inner) => (el.innerHTML = `<section class="card-box proofs"><h3 class="section-title">What employers see</h3>${inner}</section>`);
    if (!ctx.projects.length) return shell(`<p class="faint small">${ctx.hasTex ? "No linked projects were found in your resume." : "Upload your resume as LaTeX (.tex) so its project links can be checked."}</p>`);
    shell(`<p class="faint small">Checking your projects on GitHub…</p>`);
    let au;
    try { au = await audit(force); } catch (e) { return shell(`<p class="small bad-t">${esc(e.message)}</p>`); }
    const rows = ctx.projects.map((p) => { const cs = checksFor(p, au.projects[p.name], au); return { p, a: au.projects[p.name], cs, score: scoreOf(cs) }; })
      .sort((a, b) => b.score - a.score);
    const jobs = await api("/api/jobs?status=new,later").catch(() => []);
    const asked = {};
    for (const j of jobs) for (const sk of new Set([...(j.card?.skills_matched || []), ...(j.card?.skills_gap || [])])) asked[sk] = (asked[sk] || 0) + 1;
    const all = proofs();
    const claimed = new Set((ctx.profile.keywords || []).filter((k) => k.keep).map((k) => lc(k.name)));
    const top = Object.entries(asked).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([s, n]) => ({ s, n, by: all.find((x) => mentions(x.text, s)), claimed: claimed.has(lc(s)) }));
    const shown = top.filter((t) => t.by), unshown = top.filter((t) => !t.by);
    const linkedinText = (p, a) => [p.name + (p.desc ? ` — ${p.desc}` : ""), p.bullets.find(hasResult) || p.bullets[0] || "",
      p.stack ? `Skills: ${p.stack.replace(/ · /g, ", ")}` : "", a?.repo?.html || a?.live || p.urls[0] || ""].filter(Boolean).join("\n");
    const profileChecks = [
      { ok: au.resumeLink.ok, label: "The GitHub link in your resume header works",
        fix: au.resumeLink.ok ? "" : `${au.resumeLink.url} is a dead page${au.login ? ` — your account is github.com/${au.login} now. Update the header link and every project link.` : "."}` },
      { ok: !!au.bio, label: "Your GitHub bio says what you do and that you're looking", fix: "Profile → Edit profile → Bio." },
      ...(au.pinned ? [{ ok: rows.slice(0, 3).every((r) => !r.a?.repo || au.pinned.some((n) => lc(n) === lc(r.a.repo.full.split("/")[1]))),
        label: "Your strongest projects are pinned", fix: `Pinned now: ${au.pinned.join(", ") || "none"}. Pin your best three or four: profile → Customize your pins.` }] : []),
    ];
    el.innerHTML = `<section class="card-box proofs">
      <div class="wk-head"><h3 class="section-title" style="margin:0">What employers see</h3><button class="btn tiny" id="pf-recheck">Check again</button></div>
      <p class="faint small">A reviewer opens the links in your resume and decides in a minute whether the claims are real.
        This checks what they'll find and gives you the fix — proof only counts where they can see it.</p>
      <ul class="checks">${profileChecks.map((c) => `<li>${mark(c.ok)}<span>${esc(c.label)}${c.ok !== true && c.fix ? `<div class="small muted">${esc(c.fix)}</div>` : ""}</span></li>`).join("")}</ul>
      ${rows.map(({ p, a, cs }) => `<details class="pj" ${cs.some((c) => c.ok === false) ? "open" : ""}>
          <summary><b>${esc(p.name)}</b> <span class="faint small">${cs.filter((c) => c.ok === true).length}/${cs.length} checks</span>
            ${a?.repo?.html ? `<a class="small" href="${esc(a.repo.html)}" target="_blank" rel="noopener">open ↗</a>` : ""}</summary>
          <ul class="checks">${cs.map((c) => `<li>${mark(c.ok)}<span>${esc(c.label)}${c.ok !== true && c.fix ? `<div class="small muted">${esc(c.fix)}</div>` : ""}
            ${c.ok !== true && c.copy ? `<pre class="paste">${esc(c.copy)}</pre>${copyBtn(c.copy)}` : ""}</span></li>`).join("")}</ul>
          <div class="li-kit"><div class="small"><b>For LinkedIn → Add section → Projects</b></div>
            <pre class="paste">${esc(linkedinText(p, a))}</pre>${copyBtn(linkedinText(p, a))}
            <label class="small"><input type="checkbox" class="pf-li" data-p="${esc(p.name)}" ${ctx.state[p.name]?.linkedin ? "checked" : ""}> It's on my LinkedIn</label></div>
        </details>`).join("")}
      ${au.repos.length ? `<h4>On your GitHub, not on your resume</h4><ul class="checks">${au.repos.slice(0, 5).map((r) => `<li>${mark("warn")}<span>
          <a href="${esc(r.html)}" target="_blank" rel="noopener">${esc(r.name)}</a>${r.description ? ` — ${esc(r.description)}` : ""}
          <div class="small muted">If it's stronger than what's on your resume, add it with one measured result.</div></span></li>`).join("")}</ul>` : ""}
      ${top.length ? `<h4>What your board's jobs ask for</h4>
        ${shown.length ? `<p class="small">Your projects already show: ${shown.map((t) => `<span class="chip good" title="shown by ${esc(t.by.title)}">${esc(t.s)} · ${t.n}</span>`).join(" ")}</p>` : ""}
        <ul class="next-proof">${unshown.map((t) => { const w = nextStep(t.s); return `<li><b>${esc(t.s)}</b>
          <span class="faint small">asked by ${t.n} job${t.n > 1 ? "s" : ""} · ${t.claimed ? "on your resume, but nothing shows it" : "not on your resume"}</span>
          <div class="small">${esc(w.how)}${w.url ? ` <a href="${w.url}" target="_blank" rel="noopener">HackerRank certifications ↗</a>` : ""}</div></li>`; }).join("")}</ul>` : ""}
      <details class="extra"><summary class="small">Add a certificate or test result (not on your resume)</summary>
        <div class="pf-list">${ctx.extras.map((x, i) => `<div class="pf-item"><div class="grow"><b>${esc(x.title)}</b>
          ${x.url ? `<a class="small" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url.replace(/^https?:\/\//, "").slice(0, 48))}</a>` : ""}
          <div class="chips">${(x.skills || []).map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</div></div>
          <button class="icon-btn pf-del" data-i="${i}" aria-label="Remove">✕</button></div>`).join("")}</div>
        <form class="pf-form" id="pf-form" autocomplete="off">
          <input class="input" name="title" placeholder="e.g. HackerRank Python (Basic) certificate" required>
          <input class="input" name="url" placeholder="Verification link" type="url" required>
          <input class="input" name="skills" placeholder="Skills it shows, comma-separated">
          <button class="btn">Add</button></form></details>
      <h4>For drafts and alumni search</h4>
      <div class="pf-links">
        <label>GitHub <input class="input" id="pf-github" value="${esc(ctx.links.github)}" placeholder="https://github.com/you"></label>
        <label>LinkedIn <input class="input" id="pf-linkedin" value="${esc(ctx.links.linkedin)}" placeholder="https://www.linkedin.com/in/you"></label>
        <label>School / college <input class="input" id="pf-school" value="${esc(ctx.links.school)}" placeholder="University of Delhi"></label>
      </div>
    </section>`;
    el.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy).catch(() => {}); toast("Copied"); }));
    el.querySelector("#pf-recheck").onclick = () => proofSection(el, true);
    el.querySelectorAll(".pf-li").forEach((cb) => (cb.onchange = async () => {
      const state = { ...ctx.state, [cb.dataset.p]: { ...(ctx.state[cb.dataset.p] || {}), linkedin: cb.checked } };
      await api("/api/profile", { method: "PATCH", json: { proof_state: state } });
      ctx.state = state;
      toast(cb.checked ? "Marked as on LinkedIn" : "Unmarked");
    }));
    const saveExtras = async (list) => { await api("/api/profile", { method: "PATCH", json: { proofs: list } }); await proofSection(el); };
    el.querySelector("#pf-form").onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      saveExtras([...ctx.extras, { id: uid(), title: f.title.value.trim(), url: f.url.value.trim(), kind: "certificate",
        skills: f.skills.value.split(",").map((s) => s.trim()).filter(Boolean), added: today() }]);
    };
    el.querySelectorAll(".pf-del").forEach((b) => (b.onclick = () => saveExtras(ctx.extras.filter((_, j) => j !== +b.dataset.i))));
    for (const k of ["github", "linkedin", "school"]) el.querySelector(`#pf-${k}`).onchange = async (e) => {
      await api("/api/profile", { method: "PATCH", json: { [k]: e.target.value.trim() } });
      try { localStorage.removeItem(AUDIT_KEY); } catch (_) { /* storage off */ }
      await proofSection(el, true);
      toast("Saved");
    };
  }

  return { load, audit, open, cardLine, proofFor, fromPosting, draft, weekPanel, proofSection, odds, channelOf, isoWeek, projectsFromTex };
})();
