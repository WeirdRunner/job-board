// The board's own decision model, run in the browser: the exported encoder (sysone/export_onnx.py) on onnxruntime-web
// (WebGPU when the browser has it, otherwise multi-threaded WebAssembly) and its tokenizer on transformers.js.
// Builds model input exactly like sysone/encoder.py `encode`, and answers in the /v1/systemone shape, so the board's
// code can't tell it from a hosted engine. Usage:
//   const d = await Decider.load("models/laya-jobs/onnx", {variant: "fp16", onProgress});
//   const answers = await d.ask(state, questions);
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs";
const HF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";

// Python's str() for the scalars that appear in job and candidate state.
const pyStr = (v) => (v === true ? "True" : v === false ? "False" : String(v));

export function renderState(state) {
  if (typeof state === "string") return state;
  const lines = [];
  const walk = (prefix, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x);
    } else if (Array.isArray(v)) {
      if (v.every((x) => !(x && typeof x === "object"))) lines.push(`${prefix}: ` + v.map(pyStr).join("; "));
      else v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    } else if (v !== null && v !== undefined && v !== "") {
      lines.push(`${prefix}: ${pyStr(v)}`);
    }
  };
  walk("", state);
  return lines.join("\n");
}

export function options(q) {
  const c = q.criteria;
  if (q.type === "noul") {
    const cc = c || {};
    return [["false", `false: ${"false" in cc ? pyStr(cc.false) : "no"}`], ["true", `true: ${"true" in cc ? pyStr(cc.true) : "yes"}`]];
  }
  if (q.type === "score") return c.map((x, i) => [String(i), `${i}: ${x}`]);
  return Object.entries(c).map(([k, v]) => [k, v ? `${k}: ${v}` : String(k)]);
}

const family = (qid) => qid.replace(/_\d+$/, "_*");

export class Decider {
  static async load(folder, { variant = "fp16", device = "auto", threads = 0, onProgress = () => {} } = {}) {
    const [ort, hf] = await Promise.all([import(ORT_URL), import(HF_URL)]);
    const base = new URL(folder.replace(/\/?$/, "/"), location.href).href;
    const meta = await (await fetch(base + "decision.json")).json();
    hf.env.allowLocalModels = true;
    hf.env.allowRemoteModels = false;
    hf.env.localModelPath = base.replace(/[^/]+\/$/, "");
    const tok = await hf.AutoTokenizer.from_pretrained(base.match(/([^/]+)\/$/)[1]);
    ort.env.wasm.numThreads = threads || Math.min(4, navigator.hardwareConcurrency || 4);
    const bytes = await loadModelBytes(base, `model${variant ? "_" + variant : ""}.onnx`, meta.rev || "", onProgress);
    const eps = device === "wasm" ? ["wasm"] : device === "webgpu" ? ["webgpu"] : (navigator.gpu ? ["webgpu", "wasm"] : ["wasm"]);
    const session = await ort.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: "all" });
    return new Decider(ort, tok, session, meta, eps[0]);
  }

  constructor(ort, tok, session, meta, device) {
    Object.assign(this, { ort, tok, session, meta, device });
    this.sp = meta.special_ids;
  }

  ids(text, max) {
    // Python's tokenizer splits text at added tokens (newline runs, tab runs …) and its Metaspace step
    // (prepend_scheme "always") then marks the first word of every piece as starting a word; transformers.js 3.0.2
    // skips that marker. A leading space normalizes to the same "▁", so each piece gets one unless it has one.
    if (!this.addedRe) {
      const added = (this.tok.added_tokens || []).filter((t) => !t.special).map((t) => t.content).sort((a, b) => b.length - a.length);
      this.addedRe = new RegExp("(" + added.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")");
      this.addedSet = new Set(added);
    }
    const ids = [];
    for (const piece of text.split(this.addedRe)) {
      if (!piece) continue;
      const enc = this.addedSet.has(piece) ? piece : piece.startsWith(" ") ? piece : " " + piece;
      ids.push(...this.tok.encode(enc, { add_special_tokens: false }));
    }
    return max ? ids.slice(0, max) : ids;
  }

  encode(state, questions) {
    const ids = [this.sp.cls];
    const layout = [];
    for (const [qid, q] of Object.entries(questions)) {
      const qpos = ids.length;
      ids.push(this.sp.question, ...this.ids(`${q.type} question: ${q.instructions}`, 120));
      const opts = [];
      for (const [k, text] of options(q)) {
        opts.push([k, ids.length]);
        ids.push(this.sp.mask, ...this.ids(" " + text, 48));
      }
      layout.push([qid, qpos, opts]);
    }
    ids.push(this.sp.sep);
    const room = this.meta.max_len - ids.length - 1;
    if (room < 64) throw new Error(`${Object.keys(questions).length} questions leave no room for the state`);
    ids.push(...this.ids(renderState(state), room), this.sp.sep);
    return { ids, layout };
  }

  async ask(state, questions, maxQuestions = 24) {
    const entries = Object.entries(questions);
    if (entries.length > maxQuestions) {
      const out = {};
      for (let i = 0; i < entries.length; i += maxQuestions)
        Object.assign(out, await this.ask(state, Object.fromEntries(entries.slice(i, i + maxQuestions)), maxQuestions));
      return out;
    }
    const { ids, layout } = this.encode(state, questions);
    const input = new this.ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]);
    const res = await this.session.run({ input_ids: input });
    const q = res.q.data, o = res.o.data, d = this.meta.head_dim;
    const out = {};
    for (const [qid, qpos, opts] of layout) {
      const t = this.meta.temperature * (this.meta.temps[family(qid)] || 1) * Math.sqrt(d);
      const z = opts.map(([, p]) => { let s = 0; for (let j = 0; j < d; j++) s += o[p * d + j] * q[qpos * d + j]; return s / t; });
      const m = Math.max(...z), e = z.map((x) => Math.exp(x - m)), sum = e.reduce((a, b) => a + b, 0);
      out[qid] = answer(questions[qid], opts.map(([k]) => k), e.map((x) => x / sum));
    }
    return out;
  }
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

function answer(q, keys, p) {
  const probs = Object.fromEntries(keys.map((k, i) => [k, r4(p[i])]));
  if (q.type === "noul") return { type: "noul", noul: probs.true };
  const best = keys.reduce((a, b) => (probs[b] > probs[a] ? b : a));
  if (q.type === "score")
    return { type: "score", score: r4(keys.reduce((s, k) => s + Number(k) * probs[k], 0)), confidence: probs[best],
             legend: Object.fromEntries(keys.map((k, i) => [k, String(q.criteria[i])])), probabilities: probs };
  return { type: "choice", choice: best, confidence: probs[best], probabilities: probs };
}

// The model is published in parts under 100 MB (GitHub's file limit) next to <name>.parts.json, and kept in Cache
// Storage after the first download, so it's fetched once per model version, not on every visit.
async function loadModelBytes(base, name, rev, onProgress) {
  const cache = await caches.open(`board-model-${rev || "dev"}`).catch(() => null);
  let parts = [name], size = 0;
  const man = await fetch(base + name.replace(/\.onnx$/, ".parts.json")).catch(() => null);
  if (man && man.ok) ({ parts, size } = await man.json());
  const total = { got: 0, size };
  const chunks = [];
  for (const part of parts) {
    const url = base + part;
    let r = cache && (await cache.match(url));
    if (!r) {
      r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      if (cache) { await cache.put(url, r.clone()).catch(() => {}); }
    }
    chunks.push(await readWithProgress(r, (n) => onProgress((total.got += n), total.size), (n) => size || (total.size += n)));
  }
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

async function readWithProgress(r, onBytes, onSize) {
  onSize(Number(r.headers.get("content-length")) || 0);
  const reader = r.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.length);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
