// The in-browser board's engine, in a Web Worker so the page stays responsive: the board's own Python (app/browser.py
// and the modules it uses, run by Pyodide) fetches postings, builds the questions and scores the answers; the board's
// decision model (web/decider.js) answers them on this device. Nothing leaves the browser except the requests to
// the public job boards themselves.
//
// Messages in:  {id, op: "init" | "profile" | "run", ...}     out: {id, ok, result | error}, and {event: ...} updates.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";
const PY_FILES = ["__init__", "browser", "lang", "pay", "profile", "questions", "scoring", "settings", "sources",
                  "systemone", "urls"];
let py = null, B = null, decider = null, cfg = {};

const emit = (event, data = {}) => postMessage({ event, ...data });
const log = (line) => emit("log", { line });

async function initPython() {
  if (B) return;
  emit("stage", { stage: "Loading the board's code (first time only)" });
  const { loadPyodide } = await import(PYODIDE + "pyodide.mjs");
  py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage(["requests", "beautifulsoup4", "pyodide-http", "micropip"]);
  await py.pyimport("micropip").install("pypdf");
  py.FS.mkdirTree("/board/app");
  await Promise.all(PY_FILES.map(async (f) => {
    const r = await fetch(new URL(`${cfg.pyBase}app/${f}.py`, self.location.href));
    if (!r.ok) throw new Error(`couldn't load app/${f}.py (HTTP ${r.status})`);
    py.FS.writeFile(`/board/app/${f}.py`, await r.text());
  }));
  py.runPython("import sys; sys.path.insert(0, '/board')");
  B = py.pyimport("app.browser");
  B.setup();
}

async function initModel() {
  if (decider) return;
  const { Decider } = await import(new URL("decider.js", self.location.href).href);
  emit("stage", { stage: "Downloading the decision model (first time only)" });
  decider = await Decider.load(cfg.modelBase, { variant: "fp16",
    onProgress: (got, total) => emit("download", { got, total }) });
  log(`Decision model ready (${decider.device === "webgpu" ? "GPU" : "CPU"})`);
}

// Python <-> JS: plain data both ways.
const toPy = (x) => py.toPy(x);
const toJs = (x) => (x && x.toJs ? x.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false }) : x);
const call = (fn, ...args) => toJs(B[fn](...args.map((a) => (a && typeof a === "object" ? toPy(a) : a))));

async function profile({ name, bytes, old }) {
  await initPython();
  const path = `/board/upload/${name.replace(/[^\w.-]+/g, "_")}`;
  py.FS.mkdirTree("/board/upload");
  py.FS.writeFile(path, new Uint8Array(bytes));
  return call("profile_from_resume", path, name, old || null);
}

// One run: fetch -> triage titles -> read the best ones in full -> score. Rows stream back as they're scored.
async function run({ settings, profile, known, tracked }) {
  await initPython();
  const terms = toJs(B.search_terms(toPy(profile)));
  emit("stage", { stage: `Fetching postings (${settings.sources.length} sources)` });
  const got = call("fetch", settings, terms, known, tracked, py.toPy(log));
  log(`${got.fetched} postings · ${got.fresh.length} new`);
  const skip = new Set(got.already_tracked);
  const fresh = got.fresh.filter((j) => !skip.has(j.id));
  emit("rows", { rows: got.fresh.filter((j) => skip.has(j.id)).map((j) => ({ ...j, status: "applied", reason: "already in Tracker" })) });
  if (!fresh.length) return { fetched: got.fetched, fresh: 0, triaged_in: 0, evaluated: 0, loaded: 0 };

  await initModel();
  const batches = call("triage_batches", fresh, profile);
  emit("stage", { stage: "Reading job titles", total: fresh.length, done: 0 });
  const passed = [], byId = Object.fromEntries(fresh.map((j) => [j.id, j]));
  let done = 0;
  for (const b of batches) {
    const answers = await decider.ask(b.state, b.questions, 24);
    for (const t of call("triage_result", answers, b.ids)) {
      if (t.ok) passed.push({ ...t, job: byId[t.id] });
      else emit("rows", { rows: [{ ...byId[t.id], status: "triaged_out", reason: t.reason, triage: { field: t.field, above: t.above } }] });
    }
    emit("progress", { done: (done += b.ids.length), total: fresh.length });
  }
  passed.sort((a, b) => b.priority - a.priority);
  const todo = passed.slice(0, settings.max_deep);
  log(`${passed.length} of ${fresh.length} titles look relevant · reading ${todo.length} in full`);

  emit("stage", { stage: "Reading postings", total: todo.length, done: 0 });
  let loaded = 0;
  for (const [i, t] of todo.entries()) {
    try {
      const req = call("eval_request", t.job, profile);
      const answers = await decider.ask(req.state, req.questions, 32);
      const c = call("card", t.job, answers, profile, req.skills, req.gaps, settings.min_match);
      const row = call("board_row", t.job, c, answers, req.skills, req.gaps);
      loaded += row.status === "new";
      emit("rows", { rows: [{ ...row, triage: { field: t.field, above: t.above } }] });
    } catch (e) {
      log(`✗ ${t.job.title}: ${e.message || e}`);
    }
    emit("progress", { done: i + 1, total: todo.length });
  }
  log(`✓ ${loaded} jobs on your board`);
  return { fetched: got.fetched, fresh: fresh.length, triaged_in: passed.length, evaluated: todo.length, loaded };
}

const OPS = {
  init: async (m) => { cfg = m.cfg; await initPython(); return toJs(B.defaults()); },
  profile,
  run,
  rescore: async ({ rows, profile, min_match }) => { await initPython(); return call("rescore", rows, profile, min_match); },
};

onmessage = async ({ data: m }) => {
  try {
    postMessage({ id: m.id, ok: true, result: await OPS[m.op](m) });
  } catch (e) {
    postMessage({ id: m.id, ok: false, error: String(e && e.message || e) });
  }
};
