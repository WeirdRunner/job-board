/* Proof, people and plan: the parts of a job search that research says move the odds (see docs/EVIDENCE.md).
 *
 *  1. Proof   — which of a job's required skills you can show credible proof for (Carranza et al. 2022; Athey &
 *               Palikot 2024; Pallais 2014). Proofs live in profile.proofs.
 *  2. People  — who to reach at a company: contacts the posting itself publishes, plus searches you open yourself
 *               (nothing is scraped, nothing is sent for you), a draft built from your proof, and a log on the
 *               tracker row (contacts + channel). Weak ties and referrals: Rajkumar et al. 2022; Brown et al. 2016.
 *  3. Plan    — a written weekly plan shown against what you actually did; no reminders (Abel et al. 2019 found a
 *               plan helped and reminders added nothing). Plans live in settings.plans.
 *
 * Uses app.js globals (esc, api, toast, $, skillTerms, refreshStatus) at call time.
 */
const Outreach = (() => {
  let ctx = null;                                   // { profile, links } — loaded once, refreshed after edits
  const uid = () => Math.random().toString(36).slice(2, 10);
  const lc = (s) => String(s || "").toLowerCase();
  const enc = encodeURIComponent;

  async function load(force = false) {
    if (ctx && !force) return ctx;
    const profile = (await api("/api/profile").catch(() => null)) || {};
    const links = { github: profile.github || "", linkedin: profile.linkedin || "", school: profile.school || "" };
    if (!links.github || !links.linkedin || !links.school) {          // fill gaps from the resume's own links
      const tex = (await api("/api/resume").catch(() => null))?.tex || "";
      links.github ||= (tex.match(/https?:\/\/(?:www\.)?github\.com\/[\w-]+(?=[}\s/])/) || [""])[0];
      links.linkedin ||= (tex.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/) || [""])[0];
      // The university first: a wider alumni network than a single college.
      links.school ||= (tex.match(/University of [A-Z]\w+(?: [A-Z]\w+)?|[A-Z][\w.]+(?: [A-Z][\w.]+)* (?:University|Institute of Technology)/)
        || tex.match(/[A-Z][\w.]+(?: [A-Z][\w.]+)* College/) || [""])[0];
    }
    ctx = { profile, links, proofs: profile.proofs || [] };
    return ctx;
  }

  // ---------------------------------------------------------------- proof
  const covers = (proof, skill) => {
    const want = skillTerms([skill]).map(lc);
    return (proof.skills || []).some((s) => skillTerms([s]).map(lc).some((t) => want.includes(t)));
  };

  function proofFor(job, proofs = ctx?.proofs || []) {
    const c = job.card || {};
    const have = new Set((ctx?.profile?.keywords || []).filter((k) => k.keep).map((k) => lc(k.name)));
    const required = [...new Set([...(c.skills_matched || []), ...(c.skills_gap || [])])];
    const out = { proven: [], claimed: [], missing: [], best: [] };
    for (const s of required) {
      const p = proofs.find((x) => covers(x, s));
      if (p) out.proven.push({ skill: s, proof: p });
      else if ((c.skills_matched || []).includes(s) || have.has(lc(s))) out.claimed.push(s);
      else out.missing.push(s);
    }
    out.best = [...proofs].map((p) => ({ p, n: required.filter((s) => covers(p, s)).length }))
      .filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 2).map((x) => x.p);
    if (!out.best.length && proofs.length) out.best = [proofs[0]];
    return out;
  }

  // Where a skill can be proven credibly and for free (or cheaply). Generic on purpose: the evidence is about
  // *credible, verifiable* signals — a certificate mill or a self-rated badge doesn't count (Abel et al. 2020).
  const WAYS = [
    [/python|sql|javascript|react|java\b|problem/i, "a proctored skill test such as HackerRank's skills certification", "https://www.hackerrank.com/skills-verification"],
    [/machine learning|pytorch|tensorflow|deep learning|nlp|llm|transformers|data science|pandas/i, "a public notebook or model with an evaluation number (Kaggle, Hugging Face)", "https://www.kaggle.com/learn"],
    [/docker|kubernetes|aws|gcp|azure|terraform|ci\/cd|devops|linux/i, "a small public repo that deploys with it, with CI passing — or the provider's own entry certification", "https://github.com/features/actions"],
    [/.*/, "a small public project that uses it, with a README that shows a measured result", null],
  ];
  const wayFor = (skill) => WAYS.find(([re]) => re.test(skill));

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

  function roleOf(job) {
    let t = String(job.title || "").replace(/https?:\/\/\S+/g, "").trim();
    if (job.source === "hackernews" && t.includes("|")) {
      const parts = t.split("|").map((x) => x.trim()).filter(Boolean);
      t = parts.find((x, i) => i > 0 && /engineer|developer|scientist|analyst|designer|manager|intern|roles?|lead|architect/i.test(x)) || parts[1] || parts[0];
    }
    return t.replace(/\s{2,}/g, " ").slice(0, 80) || "the open role";
  }

  // ---------------------------------------------------------------- drafts
  const TYPES = { manager: "Hiring manager / founder", engineer: "Engineer (referral ask)", alumni: "Alum",
                  recruiter: "Recruiter (after applying)", followup: "Follow-up" };

  function draft(type, job, who = "") {
    const p = ctx?.profile || {}, L = ctx?.links || {};
    const me = (p.name || "").split(" ")[0] || p.name || "";
    const first = (who || "").split(" ")[0] || "[name]";
    const pr = proofFor(job), best = pr.best[0];
    const proofLine = best ? `${best.title}${best.url ? ` (${best.url})` : ""}${best.note ? ` — ${best.note}` : ""}`
                           : "[your most relevant project, with a link and one measured result]";
    const stack = pr.proven.slice(0, 3).map((x) => x.skill);
    const stackLine = stack.length ? ` It uses ${stack.join(", ")}, which the posting asks for.` : "";
    const sign = [p.name || "", [L.github, L.linkedin].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
    const role = roleOf(job), co = job.company || "[company]";
    const T = {
      manager: `Subject: ${role} — ${best ? best.title : "a relevant project"}\n\nHi ${first},\n\n[One line about something specific they built or wrote.] I'm interested in the ${role} role at ${co}. The most relevant thing I've built: ${proofLine}.${stackLine}\n\nWould you be open to a 15-minute call, or would you rather I apply through the posting? Happy to walk through the code.\n\nThanks,\n${sign}`,
      engineer: `Hi ${first} — I'm about to apply for ${role} at ${co} and saw you work there. [One line about their work.] Could I ask you two quick questions about what the team values in new engineers?\n\nFor context, I built ${proofLine}.${stackLine} If it looks like a fit after that, I'd be grateful for a referral — no pressure either way.\n\n${me}`,
      alumni: `Hi ${first} — fellow ${L.school || "[school]"} alum here. I'm applying for ${role} at ${co}. Would you have 10 minutes to tell me what the team looks for in new engineers?\n\nHere's what I've been building: ${proofLine}.\n\nThanks!\n${me}`,
      recruiter: `Hi ${first} — I've applied for ${role} at ${co}${job.url ? ` (${job.url})` : ""}. One thing that may help the review: ${proofLine}.${stackLine} Happy to share anything else that's useful.\n\n${sign}`,
      followup: `Hi ${first} — following up on my note about the ${role} role, in case it got buried. [If true: one new thing since — e.g. a result, a fix, a deployment.] Totally fine if now isn't a good time.\n\n${me}`,
    };
    return T[type] || T.manager;
  }

  const GUIDE = `<ul class="guide">
    <li><b>Read one thing they made first</b> (a post, repo, talk) and open with it. Fill in every [bracket] — never send one.</li>
    <li><b>One link, your best proof for this job.</b> Under 120 words. No attachments.</li>
    <li><b>Ask for something small</b> — two questions or 15 minutes, not "a job".</li>
    <li><b>Follow up once</b> after 5–7 days; stop after two follow-ups. At most two people per company per week.</li>
    <li>Personal email or LinkedIn message — not a bulk tool. These drafts are a start; your own words carry the signal
      (AI-written applications lost most of their value once everyone used them: Galdin &amp; Silbert, 2025).</li>
  </ul>`;

  // ---------------------------------------------------------------- the panel (from a card or a tracker row)
  const STATUSES = { to_contact: "To contact", messaged: "Messaged", replied: "Replied", referred: "Referred", no_reply: "No reply" };
  const KINDS = { manager: "Manager / founder", engineer: "Engineer", alumni: "Alum", recruiter: "Recruiter", other: "Other" };
  const channelOf = (contacts) => contacts.some((c) => c.status === "referred") ? "referral"
    : contacts.some((c) => c.status && c.status !== "to_contact") ? "warm" : "cold";

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
          ${ctx.links.school ? "" : `<p class="faint small">Add your school in Profile → Proof &amp; reach-out to get an alumni search.</p>`}
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
    const redraw = () => {
      $b("#o-draft").value = draft(type, job, $b("#o-who").value.trim());
      words();
    };
    const words = () => {
      const n = ($b("#o-draft").value.replace(/^Subject:.*\n/, "").match(/\S+/g) || []).length;
      const left = ($b("#o-draft").value.match(/\[[^\]]+\]/g) || []).length;
      $b("#o-words").textContent = `${n} words${n > 140 ? " — try to cut" : ""}${left ? ` · ${left} [bracket]${left > 1 ? "s" : ""} to fill` : ""}`;
    };
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

    // Log: contacts live on the tracker row; one is created (status Saved) on the first entry.
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
    const addContact = (name, kind, handle) => save([...(row?.contacts || []),
      { id: uid(), name, kind, handle, status: "to_contact", messaged_on: null, followups: [], added_on: today() }]);
    $b("#o-add").onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      addContact(f.name.value.trim(), f.kind.value, f.handle.value.trim());
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

  const today = () => new Date().toISOString().slice(0, 10);
  const daysSince = (d) => d ? Math.floor((Date.now() - new Date(d + "T00:00:00").getTime()) / 864e5) : 0;
  const followDue = (c) => c.status === "messaged" && (c.followups?.length || 0) < 2
    && daysSince(c.followups?.at(-1) || c.messaged_on) >= 6;

  function proofHTML(pr) {
    if (!pr.proven.length && !pr.claimed.length && !pr.missing.length)
      return `<p class="faint small">This posting's skills weren't read yet.</p>`;
    const row = (cls, label, items) => items.length ? `<div class="pf-row"><span class="pf-k ${cls}">${label}</span><div>${items}</div></div>` : "";
    return `${row("good", "Proven", pr.proven.map((x) => `<span class="chip good" title="${esc(x.proof.title)}">${esc(x.skill)}</span>`).join(""))}
      ${row("warn", "You claim it, no proof", pr.claimed.map((s) => `<span class="chip warn">${esc(s)}</span>`).join(""))}
      ${row("bad", "They ask, you lack", pr.missing.map((s) => `<span class="chip bad">${esc(s)}</span>`).join(""))}
      ${pr.best.length ? `<p class="small">Lead with <b>${esc(pr.best[0].title)}</b>${pr.best[0].url ? ` · <a href="${esc(pr.best[0].url)}" target="_blank" rel="noopener">link</a>` : ""}.</p>`
        : `<p class="small faint">Add proofs in Profile → Proof &amp; reach-out, then they show up here and in your drafts.</p>`}
      ${pr.claimed.length ? `<p class="faint small">Cheapest next proof: ${esc(pr.claimed[0])} — ${esc(wayFor(pr.claimed[0])[1])}.</p>` : ""}`;
  }

  // A line on the job card: proof at a glance + the button that opens the panel.
  function cardLine(job) {
    if (!ctx) return `<div class="reach-line"><button class="btn small" data-reach="${esc(job.id)}">Reach out</button></div>`;
    const pr = proofFor(job), posted = fromPosting(job).filter((c) => c.kind !== "name");
    const total = pr.proven.length + pr.claimed.length + pr.missing.length;
    return `<div class="reach-line">
      <span class="small">${total ? `<b>${pr.proven.length}/${total}</b> skills proven` : "Proof"}${posted.length ? ` · <b>${posted.length}</b> contact${posted.length > 1 ? "s" : ""} in the posting` : ""}</span>
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
    const due = rows.flatMap((r) => (r.contacts || []).filter(followDue).map((c) => ({ c, r })));
    return { applied, reached, follow, replies, due };
  }

  // The chance of hearing nothing back from n applications if each has probability p of a callback. 4.7% is the
  // average callback rate for applicants with little experience in Kroft, Lange & Notowidigdo (2013).
  const P_CALLBACK = 0.047;
  function odds(rows) {
    const sent = rows.filter((r) => r.status && r.status !== "Saved" && r.status !== "Withdrawn").length;
    const heard = rows.filter((r) => ["Assessment", "Interviewing", "Offer"].includes(r.status)).length;
    const none = Math.pow(1 - P_CALLBACK, sent);
    return { sent, heard, none };
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
        <label class="grow">Focus <input class="input" name="focus" value="${esc(plan?.focus || "")}" placeholder="e.g. AI startups in Bengaluru; get the HackerRank Python cert"></label>
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

  // ---------------------------------------------------------------- Profile: proofs + reach-out details
  const PROOF_KINDS = { project: "Project with a measured result", benchmark: "Benchmark / evaluation", demo: "Live demo",
    certificate: "Certificate (reputable issuer)", assessment: "Proctored skill test", oss: "Merged open-source contribution" };

  async function proofSection(el) {
    await load(true);
    const p = ctx.profile, proofs = [...ctx.proofs];
    const jobs = await api("/api/jobs?status=new,later").catch(() => []);
    // Skills your board's jobs ask for most that no proof covers yet — what to prove next.
    const asked = {};
    for (const j of jobs) for (const sk of new Set([...(j.card?.skills_matched || []), ...(j.card?.skills_gap || [])])) asked[sk] = (asked[sk] || 0) + 1;
    const unproven = Object.entries(asked).filter(([s]) => !proofs.some((x) => covers(x, s))).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const projects = Object.keys(p.projects || {}).filter((n) => !proofs.some((x) => lc(x.title) === lc(n)));
    el.innerHTML = `<section class="card-box proofs">
      <h3 class="section-title">Proof &amp; reach-out</h3>
      <p class="faint small">Employers trust what they can check. Add things a stranger can verify — a repo with a measured result, a live
        demo, a proctored test, a reputable certificate — and tag the skills each one shows. They appear on job cards and in your drafts.
        Certificates also help when posted on LinkedIn (Athey &amp; Palikot, 2024).</p>
      <div class="pf-list">${proofs.map((x, i) => `<div class="pf-item" data-i="${i}">
          <div class="grow"><b>${esc(x.title)}</b> <span class="faint small">${esc(PROOF_KINDS[x.kind] || "")}</span>
            ${x.url ? `<a class="small" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url.replace(/^https?:\/\//, "").slice(0, 48))}</a>` : `<span class="small bad-t">add a link — unverifiable proof doesn't count</span>`}
            ${x.note ? `<div class="small muted">${esc(x.note)}</div>` : ""}
            <div class="chips">${(x.skills || []).map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</div></div>
          <label class="small"><input type="checkbox" class="pf-li" ${x.on_linkedin ? "checked" : ""}> on LinkedIn</label>
          <button class="icon-btn pf-del" aria-label="Remove">✕</button></div>`).join("") || `<p class="faint small">No proofs yet.</p>`}</div>
      <form class="pf-form" id="pf-form" autocomplete="off">
        <input class="input" name="title" placeholder="What it is, e.g. Job-board decision model" required list="pf-projects">
        <datalist id="pf-projects">${projects.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
        <input class="input" name="url" placeholder="Link anyone can open" type="url">
        <select class="input" name="kind">${Object.entries(PROOF_KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <input class="input" name="skills" placeholder="Skills it shows, comma-separated">
        <input class="input" name="note" placeholder="The result in one line, e.g. 96% on a 76-job benchmark, 0.15 s/job">
        <button class="btn">Add proof</button></form>
      ${unproven.length ? `<h4>Most-asked skills you can't prove yet</h4><ul class="next-proof">${unproven.map(([s, n]) => {
        const w = wayFor(s); return `<li><b>${esc(s)}</b> <span class="faint small">asked by ${n} job${n > 1 ? "s" : ""} on your board</span>
          <div class="small">${esc(w[1])}${w[2] ? ` · <a href="${w[2]}" target="_blank" rel="noopener">start</a>` : ""}</div></li>`; }).join("")}</ul>` : ""}
      <h4>For drafts and alumni search</h4>
      <div class="pf-links">
        <label>GitHub <input class="input" id="pf-github" value="${esc(p.github || ctx.links.github)}" placeholder="https://github.com/you"></label>
        <label>LinkedIn <input class="input" id="pf-linkedin" value="${esc(p.linkedin || ctx.links.linkedin)}" placeholder="https://www.linkedin.com/in/you"></label>
        <label>School / college <input class="input" id="pf-school" value="${esc(p.school || ctx.links.school)}" placeholder="University of Delhi"></label>
      </div>
    </section>`;
    const saveProofs = async (list) => { await api("/api/profile", { method: "PATCH", json: { proofs: list } }); await proofSection(el); };
    el.querySelector("#pf-form").onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      saveProofs([...proofs, { id: uid(), title: f.title.value.trim(), url: f.url.value.trim(), kind: f.kind.value,
        skills: f.skills.value.split(",").map((s) => s.trim()).filter(Boolean), note: f.note.value.trim(), on_linkedin: false, added: today() }]);
    };
    el.querySelectorAll(".pf-item").forEach((it) => {
      const i = +it.dataset.i;
      it.querySelector(".pf-del").onclick = () => saveProofs(proofs.filter((_, j) => j !== i));
      it.querySelector(".pf-li").onchange = (e) => saveProofs(proofs.map((x, j) => j === i ? { ...x, on_linkedin: e.target.checked } : x));
    });
    for (const k of ["github", "linkedin", "school"]) el.querySelector(`#pf-${k}`).onchange = async (e) => {
      await api("/api/profile", { method: "PATCH", json: { [k]: e.target.value.trim() } });
      await load(true);
      toast("Saved");
    };
  }

  return { load, open, cardLine, proofFor, fromPosting, draft, weekPanel, proofSection, odds, channelOf, isoWeek };
})();
