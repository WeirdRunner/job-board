"use strict";
/* The board in this browser alone: no account, no keys, nothing to install. Your profile, swipes and tracker stay in
   this browser's storage (IndexedDB); job searches run here too, in web/worker.js — the board's own Python (via
   Pyodide) fetches public job boards and scores postings, and the board's decision model reads them on this device.
   web/static.js answers the app's /api calls from this data, the same way it does for a GitHub-synced board.

   Window.Local:  start(ctx) · state() · defaults() · profileFrom(file) · onboarding(view, opts, done)                              */
window.Local = (() => {
  const CFG = {
    pyBase: "static/py/",
    modelBase: "https://weirdrunner.github.io/job-board-model/laya-jobs/",
    ...(window.BOARD_CONFIG || {}),
  };
  const q = new URLSearchParams(location.search);
  if (q.get("model")) CFG.modelBase = q.get("model");          // testing a model build from somewhere else
  let worker = null, seq = 0;
  const waiting = {};
  const listeners = new Set();
  const run = { running: false, stage: "idle", done: 0, total: 0, log: [], error: null, download: null };

  function engine() {
    if (worker) return worker;
    worker = new Worker(new URL("static/worker.js", location.href), { type: "module" });
    worker.onmessage = ({ data: m }) => {
      if (m.id && waiting[m.id]) {
        const { ok, bad } = waiting[m.id];
        delete waiting[m.id];
        return m.ok ? ok(m.result) : bad(new Error(m.error));
      }
      if (m.event === "log") run.log = [...run.log.slice(-199), m.line];
      if (m.event === "stage") Object.assign(run, { stage: m.stage, done: m.done || 0, total: m.total || 0 });
      if (m.event === "progress") Object.assign(run, { done: m.done, total: m.total });
      if (m.event === "download") run.download = { got: m.got, total: m.total };
      for (const f of listeners) f(m);
    };
    worker.onerror = (e) => { run.error = e.message || "The search engine stopped"; };
    return worker;
  }
  function rpc(op, payload = {}) {
    const id = ++seq;
    return new Promise((ok, bad) => {
      waiting[id] = { ok, bad };
      engine().postMessage({ id, op, cfg: { pyBase: new URL(CFG.pyBase, location.href).href,
                                           modelBase: new URL(CFG.modelBase, location.href).href }, ...payload });
    });
  }

  let defaultsP = null;
  const defaults = () => (defaultsP ||= rpc("init"));

  /* One search. `ctx` gives what the run needs and where results go:
     {settings, profile, known, tracked, onRows(rows), onDone(stats)}                                        */
  async function start(ctx) {
    if (run.running) return run;
    Object.assign(run, { running: true, stage: "Starting", done: 0, total: 0, log: [], error: null, started: new Date().toISOString() });
    const onEvent = (m) => { if (m.event === "rows") ctx.onRows(m.rows); };
    listeners.add(onEvent);
    rpc("run", { settings: ctx.settings, profile: ctx.profile, known: ctx.known, tracked: ctx.tracked })
      .then((stats) => { ctx.onDone(stats, run); })
      .catch((e) => { run.error = e.message; ctx.onDone(null, run); })
      .finally(() => { listeners.delete(onEvent); Object.assign(run, { running: false, stage: "idle" }); });
    return run;
  }

  async function profileFrom(file, old) {
    return rpc("profile", { name: file.name, bytes: await file.arrayBuffer(), old: old || null });
  }
  const rescore = (rows, profile, min_match) => rpc("rescore", { rows, profile, min_match });

  /* ------------------------------------------------------------------ onboarding: 3 steps */
  const FIELD_SHORT = { ai_ml_engineering: "AI / ML engineering", applied_ai_products: "AI products & agents",
    data_science: "Data science", data_engineering: "Data engineering", backend: "Backend", full_stack: "Full stack",
    frontend: "Frontend", devops_platform: "DevOps / platform", research: "Research", other_engineering: "Mobile, QA, security…" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function onboarding(view, opts, done) {
    view.innerHTML = `
      <div class="card-box unlock onboard">
        <h1>Job Board</h1>
        <p class="muted">Finds jobs that fit your resume every time you open it, and tells you which are worth your time.
          Free, and everything stays in this browser.</p>
        <ol class="steps"><li class="on">Your resume</li><li>Check the basics</li><li>Find jobs</li></ol>
        <div id="ob-body">
          <label class="drop" id="ob-drop">
            <input type="file" id="ob-file" accept=".pdf,.tex,.txt,.md" hidden>
            <b>Upload your resume</b><span class="faint">PDF, LaTeX (.tex) or plain text</span>
          </label>
        </div>
        <p class="faint" id="ob-msg" aria-live="polite"></p>
        ${opts.unlockHref ? `<p class="faint">Is this your board? <a href="${opts.unlockHref}">Unlock it</a></p>` : ""}
        <details class="faint"><summary>Already have a board on GitHub?</summary>
          <p>Open it at <code>https://&lt;you&gt;.github.io/&lt;repo&gt;/</code>, or <a href="setup.html">set one up</a> — it searches
            every day even when your devices are off, and syncs across them.</p></details>
      </div>`;
    const msg = (t) => (view.querySelector("#ob-msg").textContent = t);
    const drop = view.querySelector("#ob-drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) read(e.dataTransfer.files[0]); });
    view.querySelector("#ob-file").onchange = (e) => e.target.files[0] && read(e.target.files[0]);

    async function read(file) {
      msg("Reading your resume… (the first time also loads the board's code, about 15 MB)");
      try {
        const [p, d] = await Promise.all([profileFrom(file), defaults()]);
        confirm(p, d, file);
      } catch (e) { msg(`Couldn't read that file: ${e.message}`); }
    }

    function confirm(p, d, file) {
      view.querySelectorAll(".steps li").forEach((li, i) => li.classList.toggle("on", i === 1));
      const fields = d.labels.field_labels, levels = d.labels.level_labels;
      const picked = new Set((p.fields || []).map((f) => f.name));
      // Skills you mention most (in projects and jobs, not just the skills list) come first and start ticked.
      const text = (p.resume_text || "").toLowerCase();
      const count = (s) => (text.match(new RegExp(`(?<![a-z0-9])${s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "g")) || []).length;
      const skills = (p.keywords || []).map((k, i) => ({ name: k.name, n: count(k.name), i }))
        .sort((a, b) => b.n - a.n || a.i - b.i).map((k) => k.name);
      view.querySelector("#ob-body").innerHTML = `
        <form id="ob-form" class="stack">
          <div class="field-row"><label>Name</label><input class="input" id="ob-name" value="${esc(p.name)}"></div>
          <div class="field-row"><label>Where you live</label><select class="input" id="ob-country">
            ${[...d.labels.countries, "other"].map((c) => `<option ${c === p.country ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
          <div class="field-row"><label>Your level</label><select class="input" id="ob-level">
            ${Object.entries(levels).map(([k, v]) => `<option value="${k}" ${k === p.level ? "selected" : ""}>${esc(v.split(";")[0])}</option>`).join("")}</select></div>
          <div class="field-row"><label>Roles you want</label><div class="chips" id="ob-fields">
            ${Object.entries(fields).filter(([k]) => k !== "non_engineering").map(([k, v]) =>
              `<label class="chip-check" title="${esc(v)}"><input type="checkbox" value="${k}" ${picked.has(k) ? "checked" : ""}>${esc(FIELD_SHORT[k] || k)}</label>`).join("")}</div></div>
          <div class="field-row"><label>Your top skills <span class="faint">(up to 10)</span></label><div class="chips" id="ob-skills">
            ${skills.slice(0, 30).map((s, i) => `<label class="chip-check"><input type="checkbox" value="${esc(s)}" ${i < 10 ? "checked" : ""}>${esc(s)}</label>`).join("")}</div></div>
          <button class="btn primary">Find my jobs</button>
        </form>`;
      msg("");
      const sk = view.querySelector("#ob-skills");
      sk.addEventListener("change", () => {
        const on = sk.querySelectorAll("input:checked");
        if (on.length > 10) { on[on.length - 1].checked = false; msg("Pick your 10 strongest — the board asks about each one."); }
      });
      view.querySelector("#ob-form").onsubmit = async (e) => {
        e.preventDefault();
        const chosen = new Set([...sk.querySelectorAll("input:checked")].map((i) => i.value));
        const fieldsOn = [...view.querySelectorAll("#ob-fields input:checked")].map((i) => ({ name: i.value, p: null }));
        if (!fieldsOn.length) return msg("Pick at least one kind of role.");
        const profile = { ...p,
          name: view.querySelector("#ob-name").value.trim() || p.name,
          country: view.querySelector("#ob-country").value, level: view.querySelector("#ob-level").value, fields: fieldsOn,
          keywords: [...(p.keywords || []).filter((k) => chosen.has(k.name)), ...(p.keywords || []).filter((k) => !chosen.has(k.name))]
            .map((k) => ({ ...k, keep: chosen.has(k.name) })),
          overrides: { ...(p.overrides || {}), country: view.querySelector("#ob-country").value, level: view.querySelector("#ob-level").value } };
        view.querySelectorAll(".steps li").forEach((li, i) => li.classList.toggle("on", i === 2));
        await done(profile, file);
      };
    }
  }

  return { start, state: () => run, defaults, profileFrom, rescore, onboarding, config: CFG };
})();
