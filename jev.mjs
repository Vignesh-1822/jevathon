#!/usr/bin/env node
// jev.mjs - call TypeSafe's Jev ("System One" typed-decision model), directly or through the Vercel AI Gateway.
// Written 2026-09-22 by lane 25f7cec1. Node >= 22, zero dependencies. Wrappers: jev (bash), jev.cmd (cmd/PowerShell).
//
// Jev answers typed questions about one piece of state: boolean (P(true)), choice (one of 2-255 options, with a
// probability for each) and score (a rubric of 2-10 ordered levels, fractional result). It cannot write text.
// Vendor facts and weaknesses: C:\Users\globa\ai\research\link-batch-20260921\jev-typesafe-facts.md
//
// Speculative prompting: a call costs about the same whether it carries 1 question or 20 (vendor cookbook: batching
// 13 questions into one call measured "12.2x cheaper and 10.0x faster with no change in answers" -- extra questions
// are nearly free once the round trip is paid for). So callers building a `questions` map for `jev ask` should
// include every question they MIGHT need this round, not just the one they know they need right now -- a second
// call later costs a full round trip; an unused answer in this one costs almost nothing. jev-goal.mjs's two request
// builders (judgeRequest, gradeRequest) follow this: each already asks everything its verdict policy might read.
// One thing NOT to conflate (vendor's own skill doc, docs.typesafe.ai/agent-skill, "you're using confidence
// thresholds everywhere"): to pick the best option from a choice question, take argmax(probabilities), not a
// threshold on `confidence` -- confidence is a separate, un-normalized quantity, not a substitute for the distribution.
//
// Two providers, same questions, same output shape:
//   typesafe  POST <TYPESAFE_BASE_URL or https://api.typesafe.ai>/v1/systemone, body {state, model, questions}; boolean
//             questions go out as the vendor's "noul". Key: env TYPESAFE_API_KEY, file JEV_TYPESAFE_KEY_FILE, file
//             ~/.typesafe-key. Shape from docs.typesafe.ai/introduction/quickstart (read 2026-09-22).
//   gateway   POST <JEV_GATEWAY_BASE_URL or https://ai-gateway.vercel.sh/v4/ai>/evaluation-model, model id in a header.
//             Key: env AI_GATEWAY_API_KEY, file JEV_KEY_FILE, file ~/.ai-gateway-key. Shape read from
//             @ai-sdk/gateway 4.0.89 (src/gateway-evaluation-model.ts) and @ai-sdk/provider 4.0.17.
// Provider choice: --provider, else env JEV_PROVIDER, else typesafe when a TypeSafe key exists, else gateway.
// Keys are never printed; every line this tool prints passes through redact().

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROVIDERS = {
  typesafe: {
    label: "TypeSafe", defaultModel: "jev-latest", keyEnv: "TYPESAFE_API_KEY", keyFileEnv: "JEV_TYPESAFE_KEY_FILE",
    keyFile: ".typesafe-key", baseEnv: "TYPESAFE_BASE_URL", defaultBase: "https://api.typesafe.ai",
  },
  gateway: {
    label: "Vercel AI Gateway", defaultModel: "typesafe-ai/jev", keyEnv: "AI_GATEWAY_API_KEY", keyFileEnv: "JEV_KEY_FILE",
    keyFile: ".ai-gateway-key", baseEnv: "JEV_GATEWAY_BASE_URL", defaultBase: "https://ai-gateway.vercel.sh/v4/ai",
  },
};
const PRICE_PER_INPUT_TOKEN = 0.000000042; // vendor and gateway list price 2026-09-22 ($0.042 per million); output free
const LIMITS = { maxOptions: 255, minLevels: 2, maxLevels: 10, maxTokens: 32000 };
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);

const USAGE = `jev - ask Jev (TypeSafe's typed-decision model) questions, directly or through the Vercel AI Gateway

  jev yes-no  <state> <question>                        P(true) for a yes/no question
  jev choose  <state> <question> <opt>[=<desc>] ...     pick one of 2-255 options, with probabilities
  jev score   <state> <question> <level0> <level1> ...  place the state on 2-10 ordered levels
  jev ask     <request.json | @request.json | ->        full request {"state": ..., "questions": {...}}
  jev check                                             key source, account check, one tiny probe call
  jev selftest                                          offline checks against local fake servers

  <state> is literal text, @path to a file, or - for stdin. Text that parses as JSON is sent as JSON.
  Question types in "ask": boolean | choice | score (TypeSafe's native "noul" is accepted as boolean).

  --provider <p>  typesafe | gateway. Default: env JEV_PROVIDER, else typesafe if a TypeSafe key exists, else gateway
  --json          one JSON object on stdout (also for errors)
  --model <id>    default jev-latest (typesafe) or typesafe-ai/jev (gateway)
  --timeout <ms>  default 10000, covers the one retry on 429/5xx

  Exit codes: 0 ok, 2 bad request (nothing sent), 3 key or billing problem (operator action), 4 API/network error.
  Keys: TypeSafe = env TYPESAFE_API_KEY or ~/.typesafe-key; gateway = env AI_GATEWAY_API_KEY or ~/.ai-gateway-key.
  Cost: $0.042 per million input tokens, output free.
`;

class JevError extends Error {
  constructor(exitCode, message) { super(message); this.exitCode = exitCode; }
}

let loadedKey = null;
export function redact(s) {
  let out = String(s);
  if (loadedKey) out = out.split(loadedKey).join("[redacted-key]");
  return out.replace(/vck_[A-Za-z0-9]{16,}/g, "[redacted-key]");
}

function keyFilePath(env, provider) {
  const P = PROVIDERS[provider];
  return env[P.keyFileEnv] || join(homedir(), P.keyFile);
}
function keyAvailable(env, provider) {
  if (env[PROVIDERS[provider].keyEnv]?.trim()) return true;
  const f = keyFilePath(env, provider);
  return existsSync(f) && readFileSync(f, "utf8").trim().length > 0;
}
export function resolveProvider(env, flag) {
  const name = String(flag || env.JEV_PROVIDER || "").toLowerCase();
  if (name) {
    if (!PROVIDERS[name]) throw new JevError(2, `unknown provider "${name}"; use typesafe or gateway`);
    return name;
  }
  return keyAvailable(env, "typesafe") ? "typesafe" : "gateway";
}
export function loadKey(env, provider) {
  const P = PROVIDERS[provider];
  const fromEnv = env[P.keyEnv]?.trim();
  if (fromEnv) { loadedKey = fromEnv; return { key: fromEnv, source: `env ${P.keyEnv}` }; }
  const file = keyFilePath(env, provider);
  const key = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!key) throw new JevError(3, `no ${P.label} key: set ${P.keyEnv} or put the key in ${file}`);
  loadedKey = key;
  return { key, source: `file ${file}` };
}
const baseUrl = (env, provider) => (env[PROVIDERS[provider].baseEnv] || PROVIDERS[provider].defaultBase).replace(/\/+$/, "");

// ------------------------------------------------------------------ request building and validation
function parseMaybeJson(text) {
  const t = text.trim();
  if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch { /* not JSON: send as text */ } }
  return text;
}
function readArg(arg, what) {
  if (arg === undefined) throw new JevError(2, `missing ${what}`);
  if (arg === "-") return readFileSync(0, "utf8");
  if (arg.startsWith("@")) {
    let p = arg.slice(1);
    // Git Bash style /c/Users/... -> C:/Users/... (the bash wrapper turns MSYS path conversion off)
    if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(p)) p = `${p[1]}:${p.slice(2)}`;
    if (!existsSync(p)) throw new JevError(2, `${what} file not found: ${p}`);
    return readFileSync(p, "utf8");
  }
  return arg;
}

export function normalizeRequest(req) {
  const questions = {};
  for (const [id, q] of Object.entries(req?.questions ?? {})) questions[id] = { ...q, type: q?.type === "noul" ? "boolean" : q?.type };
  return { state: req?.state, questions };
}

export function validateRequest(req) {
  const bad = [];
  if (req.state === undefined || req.state === null || req.state === "") bad.push("state is empty");
  const qs = Object.entries(req.questions ?? {});
  if (!qs.length) bad.push("no questions");
  for (const [id, q] of qs) {
    if (!["boolean", "choice", "score"].includes(q?.type)) { bad.push(`${id}: type must be boolean, choice or score (got ${q?.type})`); continue; }
    if (q.instructions === undefined || q.instructions === null || q.instructions === "") bad.push(`${id}: instructions missing`);
    if (q.type === "choice") {
      const n = q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? Object.keys(q.criteria).length : 0;
      if (n < 2 || n > LIMITS.maxOptions) bad.push(`${id}: choice needs 2-${LIMITS.maxOptions} options (got ${n})`);
    }
    if (q.type === "score") {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < LIMITS.minLevels || n > LIMITS.maxLevels) bad.push(`${id}: score needs ${LIMITS.minLevels}-${LIMITS.maxLevels} levels (got ${n})`);
    }
  }
  const approxTokens = Math.ceil(JSON.stringify({ s: req.state, q: req.questions }).length / 4);
  if (approxTokens > LIMITS.maxTokens) bad.push(`request is about ${approxTokens} tokens; Jev's context window is ${LIMITS.maxTokens}`);
  return bad;
}

function validateResponse(req, norm) {
  if (!norm || typeof norm.answers !== "object" || norm.answers === null) return ["answers missing"];
  const bad = [];
  for (const [id, q] of Object.entries(req.questions)) {
    const a = norm.answers[id];
    if (!a) bad.push(`${id}: no answer`);
    else if (a.type !== q.type) bad.push(`${id}: answer type ${a.type}, asked ${q.type}`);
    else if (q.type === "boolean" && !(a.probability >= 0 && a.probability <= 1)) bad.push(`${id}: probability out of range`);
    else if (q.type === "choice" && !Object.hasOwn(q.criteria, a.choice)) bad.push(`${id}: choice is not one of the options`);
    else if (q.type === "score" && !(a.score >= 0 && a.score <= q.criteria.length - 1)) bad.push(`${id}: score out of range`);
  }
  return bad;
}

// Wire formats. Output of both normalizers: {model, answers (boolean answers carry `probability`), usage {inputTokens,
// outputTokens}, warnings, providerMetadata}. TypeSafe also returns `confidence` (choice, score) and `legend` (score).
function buildHttp(provider, base, key, model, req) {
  if (provider === "typesafe") {
    const questions = {};
    for (const [id, q] of Object.entries(req.questions)) questions[id] = { ...q, type: q.type === "boolean" ? "noul" : q.type };
    return {
      url: `${base}/v1/systemone`,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: { state: req.state, model, questions },
    };
  }
  return {
    url: `${base}/evaluation-model`,
    headers: {
      Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      "ai-gateway-protocol-version": "0.0.1", "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4", "ai-model-id": model,
    },
    body: { state: req.state, questions: req.questions },
  };
}
function normalizeResponse(provider, body, model) {
  if (provider === "typesafe") {
    const answers = {};
    for (const [id, a] of Object.entries(body?.answers ?? {})) answers[id] = a?.type === "noul" ? { type: "boolean", probability: a.noul } : a;
    const u = body?.usage ?? {};
    return { model: body?.model ?? model, answers, usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens }, warnings: [], providerMetadata: null };
  }
  return { model, answers: body?.answers, usage: body?.usage ?? null, warnings: body?.warnings ?? [], providerMetadata: body?.providerMetadata ?? null };
}

// ------------------------------------------------------------------ HTTP
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retryAfterMs(h) {
  const ms = Number(h.get("retry-after-ms"));
  if (ms > 0) return ms;
  const s = Number(h.get("retry-after"));
  return s > 0 ? s * 1000 : null;
}
function httpError(provider, status, text) {
  const P = PROVIDERS[provider];
  let type = "", message = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    type = j?.error?.type ?? "";
    const d = j?.detail;
    message = j?.error?.message ?? (typeof d === "string" ? d : d ? JSON.stringify(d).slice(0, 300) : message);
  } catch { /* keep raw text */ }
  if (status === 401) return new JevError(3, `${P.label} rejected the key (${type || "401"}); check ${P.keyEnv} or ~/${P.keyFile}`);
  if (type === "customer_verification_required") {
    return new JevError(3, `the Vercel team that owns this key has no credit card on file, so the gateway refuses model calls. ` +
      `Operator action: add a card in the Vercel dashboard to unlock the free credits. Gateway said: ${message}`);
  }
  if (status === 402 || /insufficient|credit|quota|budget|balance/i.test(`${type} ${message}`)) {
    return new JevError(3, `${P.label} credit or budget problem (${type || status}): ${message}`);
  }
  return new JevError(4, `${P.label} HTTP ${status}${type ? ` ${type}` : ""}: ${message}`);
}

export async function evaluate(rawReq, { env = process.env, provider, model, timeoutMs = 10000 } = {}) {
  provider = provider ?? resolveProvider(env);
  model = model ?? PROVIDERS[provider].defaultModel;
  const req = normalizeRequest(rawReq);
  const bad = validateRequest(req);
  if (bad.length) throw new JevError(2, `request not sent: ${bad.join("; ")}`);
  if (!(timeoutMs > 0)) throw new JevError(2, "request not sent: --timeout needs a positive number of milliseconds");
  const { key } = loadKey(env, provider);
  const { url, headers, body } = buildHttp(provider, baseUrl(env, provider), key, model, req);
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1, deadline - Date.now()));
    const t0 = performance.now();
    let r, text;
    try {
      r = await fetch(url, { method: "POST", signal: ctl.signal, headers, body: JSON.stringify(body) });
      text = await r.text();
    } catch (e) {
      throw new JevError(4, ctl.signal.aborted ? `timeout after ${timeoutMs} ms` : `network error: ${e?.cause?.code ?? e?.message ?? e}`);
    } finally { clearTimeout(timer); }
    const ms = Math.round(performance.now() - t0);
    if (r.ok) {
      let raw;
      try { raw = JSON.parse(text); } catch { throw new JevError(4, "bad response: body is not JSON"); }
      const norm = normalizeResponse(provider, raw, model);
      const problems = validateResponse(req, norm);
      if (problems.length) throw new JevError(4, `bad response: ${problems.join("; ")}`);
      const inputTokens = norm.usage?.inputTokens;
      return {
        ok: true, provider, model: norm.model, ms, answers: norm.answers, usage: norm.usage,
        cost_usd: Number.isFinite(inputTokens) ? inputTokens * PRICE_PER_INPUT_TOKEN : null,
        warnings: norm.warnings, providerMetadata: norm.providerMetadata,
      };
    }
    if (RETRY_STATUS.has(r.status) && attempt === 0) {
      const wait = retryAfterMs(r.headers) ?? 500;
      if (Date.now() + wait < deadline) { await sleep(wait); continue; }
    }
    throw httpError(provider, r.status, text);
  }
}

// ------------------------------------------------------------------ output
const f3 = (x) => (typeof x === "number" ? x.toFixed(3) : String(x));
function footer(res) {
  const tok = res.usage?.inputTokens;
  return `[${res.model} via ${res.provider}, ${res.ms} ms${Number.isFinite(tok) ? `, ${tok} input tokens, $${res.cost_usd.toFixed(7)}` : ""}]`;
}
function dist(probabilities, label = (k) => k) {
  return Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1]).map(([k, p]) => `${label(k)} ${f3(p)}`).join(" | ");
}
const show = (s) => process.stdout.write(redact(s) + "\n");

// ------------------------------------------------------------------ commands
async function run(cmd, rest, flags, env) {
  const provider = resolveProvider(env, flags.provider);
  const model = flags.model ?? PROVIDERS[provider].defaultModel;
  const call = (req) => evaluate(req, { env, provider, model, timeoutMs: flags.timeoutMs });
  switch (cmd) {
    case "yes-no": case "yesno": case "boolean": case "bool": {
      const state = parseMaybeJson(readArg(rest[0], "state"));
      const question = readArg(rest[1], "question");
      const res = await call({ state, questions: { answer: { type: "boolean", instructions: question } } });
      if (flags.json) return show(JSON.stringify(res));
      return show(`P(true)=${f3(res.answers.answer.probability)}  ${footer(res)}`);
    }
    case "choose": case "choice": {
      const state = parseMaybeJson(readArg(rest[0], "state"));
      const question = readArg(rest[1], "question");
      const criteria = {};
      for (const opt of rest.slice(2)) {
        const i = opt.indexOf("=");
        if (i > 0) criteria[opt.slice(0, i)] = opt.slice(i + 1); else criteria[opt] = null;
      }
      const res = await call({ state, questions: { answer: { type: "choice", instructions: question, criteria } } });
      if (flags.json) return show(JSON.stringify(res));
      const a = res.answers.answer;
      const conf = typeof a.confidence === "number" ? `  confidence=${f3(a.confidence)}` : "";
      return show(`${a.choice}  p=${f3(a.probabilities?.[a.choice])}${conf}  (${dist(a.probabilities)})  ${footer(res)}`);
    }
    case "score": {
      const state = parseMaybeJson(readArg(rest[0], "state"));
      const question = readArg(rest[1], "question");
      const levels = rest.slice(2);
      const res = await call({ state, questions: { answer: { type: "score", instructions: question, criteria: levels } } });
      if (flags.json) return show(JSON.stringify(res));
      const a = res.answers.answer;
      const nearest = levels[Math.min(levels.length - 1, Math.max(0, Math.round(a.score)))];
      const conf = typeof a.confidence === "number" ? `  confidence=${f3(a.confidence)}` : "";
      return show(`score ${f3(a.score)} of 0-${levels.length - 1}, nearest "${nearest}"${conf}  (${dist(a.probabilities, (k) => `${k}:${levels[Number(k)]}`)})  ${footer(res)}`);
    }
    case "ask": {
      const text = readArg(rest[0]?.startsWith("@") || rest[0] === "-" || rest[0] === undefined ? rest[0] : `@${rest[0]}`, "request file");
      let req;
      try { req = JSON.parse(text); } catch { throw new JevError(2, "request not sent: the request is not valid JSON"); }
      const res = await call(req);
      if (flags.json) return show(JSON.stringify(res));
      return show(`${JSON.stringify({ answers: res.answers, usage: res.usage, warnings: res.warnings }, null, 2)}\n${footer(res)}`);
    }
    case "check": return check(provider, model, flags, env);
    default: throw new JevError(2, `unknown command "${cmd}". Run: jev --help`);
  }
}

async function getJson(url, key, timeoutMs, provider, what) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw httpError(provider, r.status, text);
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) {
    if (e instanceof JevError) throw e;
    throw new JevError(4, ctl.signal.aborted ? `${what} timed out after ${timeoutMs} ms` : `${what} failed: ${e?.cause?.code ?? e?.message ?? e}`);
  } finally { clearTimeout(timer); }
}

async function check(provider, model, flags, env) {
  const { key, source } = loadKey(env, provider);
  const out = { provider, key: `${key.slice(0, 4)}...${key.slice(-4)} from ${source}` };
  const base = baseUrl(env, provider);
  if (provider === "gateway") {
    const j = await getJson(`${new URL(base).origin}/v1/credits`, key, flags.timeoutMs, provider, "credits check");
    out.account = `credits balance $${j?.balance}, used $${j?.total_used}`;
  } else {
    const j = await getJson(`${base}/v1/models`, key, flags.timeoutMs, provider, "models list");
    const list = Array.isArray(j) ? j : (j?.data ?? j?.models ?? []);
    const ids = Array.isArray(list) ? list.map((m) => (typeof m === "string" ? m : m?.id ?? m?.name)).filter(Boolean) : [];
    out.account = ids.length ? `models ${ids.join(", ")}` : `models list: ${String(typeof j === "string" ? j : JSON.stringify(j)).slice(0, 160)}`;
  }
  let code = 0;
  try {
    const res = await evaluate({ state: "ping", questions: { is_ping: { type: "boolean", instructions: "Is the state the single word ping?" } } },
      { env, provider, model, timeoutMs: flags.timeoutMs });
    out.model_calls = `OK: ${res.model} answered in ${res.ms} ms, P(true)=${f3(res.answers.is_ping.probability)}`;
  } catch (e) {
    if (!(e instanceof JevError)) throw e;
    out.model_calls = `BLOCKED: ${e.message}`;
    code = e.exitCode;
  }
  if (flags.json) show(JSON.stringify({ ok: code === 0, ...out }));
  else show(`provider:    ${PROVIDERS[provider].label}\nkey:         ${out.key}\naccount:     ${out.account}\nmodel calls: ${out.model_calls}`);
  return code;
}

export async function main(argv, env = process.env) {
  const flags = { json: false, model: undefined, provider: undefined, timeoutMs: 10000 };
  const pos = [];
  let bad = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--model") { flags.model = argv[++i]; if (!flags.model) bad = "--model needs a value"; }
    else if (a === "--provider") { flags.provider = argv[++i]; if (!flags.provider) bad = "--provider needs a value"; }
    else if (a === "--timeout") flags.timeoutMs = Number(argv[++i]);
    else if (a === "-h" || a === "--help" || a === "help") { process.stdout.write(USAGE); return 0; }
    else pos.push(a);
  }
  const [cmd, ...rest] = pos;
  if (!cmd) { process.stdout.write(USAGE); return 2; }
  if (cmd === "selftest") return selftest();
  try {
    if (bad) throw new JevError(2, `request not sent: ${bad}`);
    const code = await run(cmd, rest, flags, env);
    return typeof code === "number" ? code : 0;
  } catch (e) {
    const exitCode = e instanceof JevError ? e.exitCode : 4;
    const message = redact(e instanceof JevError ? e.message : `unexpected error: ${e?.stack ?? e}`);
    if (flags.json) process.stdout.write(JSON.stringify({ ok: false, exit: exitCode, error: message }) + "\n");
    process.stderr.write(`jev: ${message}\n`);
    return exitCode;
  }
}

// ------------------------------------------------------------------ self-test: local fake servers, never the real ones
async function selftest() {
  const TEST_KEY = "vck_TESTKEY_selftest_only_0123456789abcdef";
  const TS_KEY = "ts_TESTKEY_selftest_only_fedcba9876543210";
  const self = fileURLToPath(import.meta.url);
  const seen = [];
  let rateHits = 0;
  const srv = http.createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (d) => (raw += d));
    rq.on("end", () => {
      const reply = (status, obj, headers = {}) => rs.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(obj));
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
      seen.push({ url: rq.url, auth: rq.headers.authorization, model: rq.headers["ai-model-id"], spec: rq.headers["ai-evaluation-model-specification-version"], body });
      // --- fake TypeSafe API (vendor shape: noul answers, confidence, legend, snake_case usage)
      if (rq.url === "/v1/models") return reply(rq.headers.authorization === `Bearer ${TS_KEY}` ? 200 : 401, { data: [{ id: "jev-1.13.0" }] });
      if (rq.url === "/v1/systemone") {
        if (rq.headers.authorization !== `Bearer ${TS_KEY}`) return reply(401, { detail: "Invalid API key" });
        if (body?.state === "TSCREDIT") return reply(402, { detail: "Insufficient credits" });
        const answers = {};
        for (const [id, q] of Object.entries(body.questions)) {
          if (q.type === "noul") answers[id] = { type: "noul", noul: 0.8 };
          else if (q.type === "choice") {
            const ks = Object.keys(q.criteria);
            answers[id] = { type: "choice", choice: ks[0], confidence: 0.7, probabilities: Object.fromEntries(ks.map((k, i) => [k, i === 0 ? 0.8 : 0.2 / (ks.length - 1)])) };
          } else if (q.type === "score") {
            answers[id] = { type: "score", score: 1, confidence: 0.9, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])) };
          }
        }
        return reply(200, { model: "jev-1.13.0", answers, usage: { input_tokens: 40, output_tokens: 5 } });
      }
      // --- fake Vercel AI Gateway
      if (rq.url === "/v1/credits") return reply(rq.headers.authorization === `Bearer ${TEST_KEY}` ? 200 : 401, { balance: "4.99", total_used: "0.01" });
      if (rq.url !== "/v4/ai/evaluation-model") return reply(404, { error: { message: "not found" } });
      if (rq.headers.authorization !== `Bearer ${TEST_KEY}`) return reply(401, { error: { type: "authentication_error", message: "Authentication failed." } });
      if (body?.state === "BILLING") return reply(403, { error: { type: "customer_verification_required", message: "AI Gateway requires a valid credit card on file to service requests." } });
      if (body?.state === "RATE" && rateHits++ === 0) return reply(429, { error: { type: "rate_limit_exceeded", message: "slow down" } }, { "retry-after-ms": "20" });
      if (body?.state === "SLOW") return void setTimeout(() => reply(200, {}), 1500);
      if (body?.state === "GARBAGE") return reply(200, { answers: {} });
      if (body?.state === "LEAK") return reply(500, { error: { message: `server echoed ${rq.headers.authorization}` } });
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        if (q.type === "boolean") answers[id] = { type: "boolean", probability: 0.9 };
        else if (q.type === "choice") {
          const ks = Object.keys(q.criteria);
          answers[id] = { type: "choice", choice: ks[0], probabilities: Object.fromEntries(ks.map((k, i) => [k, i === 0 ? 0.8 : 0.2 / (ks.length - 1)])) };
        } else if (q.type === "score") answers[id] = { type: "score", score: 1, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])) };
      }
      reply(200, { answers, usage: { inputTokens: 42, outputTokens: 0 }, warnings: [] });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const baseEnv = {
    ...process.env, JEV_GATEWAY_BASE_URL: `${origin}/v4/ai`, TYPESAFE_BASE_URL: origin,
    JEV_KEY_FILE: join(homedir(), ".jev-selftest-no-such-file"), JEV_TYPESAFE_KEY_FILE: join(homedir(), ".jev-selftest-no-such-file-2"),
  };
  for (const k of ["AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY", "JEV_PROVIDER"]) delete baseEnv[k];
  const withKey = { ...baseEnv, AI_GATEWAY_API_KEY: TEST_KEY };
  const withTs = { ...baseEnv, TYPESAFE_API_KEY: TS_KEY };
  const withBoth = { ...baseEnv, AI_GATEWAY_API_KEY: TEST_KEY, TYPESAFE_API_KEY: TS_KEY };
  const allOutput = [];
  const jev = (args, { env = withKey, stdin } = {}) => new Promise((res) => {
    const child = execFile(process.execPath, [self, ...args], { env, timeout: 15000 }, (err, stdout, stderr) => {
      allOutput.push(stdout, stderr);
      res({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });

  let checks = 0, fails = 0;
  const check = (name, cond, detail = "") => {
    checks += 1;
    if (!cond) fails += 1;
    console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? `  -> ${detail}` : ""}`);
  };
  const last = () => seen.at(-1);
  try {
    console.log("== gateway: happy paths");
    let r = await jev(["yes-no", "The support agent issued a full refund.", "Was a refund issued?"]);
    check("yes-no prints P(true) and exits 0", r.code === 0 && r.stdout.includes("P(true)=0.900"), JSON.stringify(r));
    check("request carries Bearer key, model id and spec version 4", last().auth === `Bearer ${TEST_KEY}` && last().model === "typesafe-ai/jev" && last().spec === "4");
    check("yes-no sends one boolean question", last().body.questions.answer.type === "boolean");
    r = await jev(["choose", "My card was charged twice.", "Which team should handle this?", "billing=Payments, refunds", "technical"]);
    check("choose prints the chosen option", r.code === 0 && r.stdout.startsWith("billing  p=0.800"), JSON.stringify(r));
    check("choose sends name=desc as a description and a bare name as null", last().body.questions.answer.criteria.billing === "Payments, refunds" && last().body.questions.answer.criteria.technical === null);
    r = await jev(["score", "I am furious.", "How frustrated is the customer?", "Calm", "Frustrated", "Very angry"]);
    check("score prints the fractional score and nearest level", r.code === 0 && r.stdout.includes('score 1.000 of 0-2, nearest "Frustrated"'), JSON.stringify(r));
    const native = { model: "jev-latest", state: { message: "hi" }, questions: { q: { type: "noul", instructions: "Is this a greeting?" } } };
    r = await jev(["ask", "-"], { stdin: JSON.stringify(native) });
    check("ask reads stdin and maps TypeSafe 'noul' to 'boolean'", r.code === 0 && last().body.questions.q.type === "boolean", JSON.stringify(r));
    check("ask ignores TypeSafe's own model name and sends the gateway id", last().model === "typesafe-ai/jev" && !("model" in last().body));
    check("JSON-looking state is sent as JSON", typeof last().body.state === "object" && last().body.state.message === "hi");
    r = await jev(["yes-no", "x", "y?", "--json", "--model", "typesafe-ai/jev-test"]);
    let env0 = null; try { env0 = JSON.parse(r.stdout); } catch { /* checked below */ }
    check("--json prints one parseable envelope with cost", env0?.ok === true && typeof env0.cost_usd === "number" && env0.answers?.answer?.type === "boolean", r.stdout);
    check("--model reaches the ai-model-id header", last().model === "typesafe-ai/jev-test");

    console.log("== validation happens before anything is sent");
    const n0 = seen.length;
    r = await jev(["choose", "x", "pick", ...Array.from({ length: 256 }, (_, i) => `o${i}`)]);
    check("256 options -> exit 2, nothing sent", r.code === 2 && seen.length === n0, JSON.stringify(r));
    r = await jev(["choose", "x", "pick", ...Array.from({ length: 255 }, (_, i) => `o${i}`)]);
    check("255 options is accepted (positive control)", r.code === 0 && seen.length === n0 + 1, JSON.stringify(r));
    const n1 = seen.length;
    r = await jev(["score", "x", "rate", "only-one-level"]);
    check("1-level score -> exit 2, nothing sent", r.code === 2 && seen.length === n1);
    r = await jev(["ask", "-"], { stdin: JSON.stringify({ state: "x", questions: { q: { type: "text", instructions: "write" } } }) });
    check("unknown question type -> exit 2, nothing sent", r.code === 2 && seen.length === n1);
    r = await jev(["yes-no", "x", "y?"], { env: baseEnv });
    check("no key anywhere -> exit 3, nothing sent", r.code === 3 && r.stderr.includes("no Vercel AI Gateway key") && seen.length === n1, JSON.stringify(r));
    r = await jev(["yes-no", "x", "y?", "--provider", "openrouter"]);
    check("unknown provider -> exit 2, nothing sent", r.code === 2 && seen.length === n1, JSON.stringify(r));

    console.log("== gateway errors map to exit codes");
    r = await jev(["yes-no", "x", "y?"], { env: { ...baseEnv, AI_GATEWAY_API_KEY: "vck_WRONGKEY_0000000000000000" } });
    check("wrong key -> exit 3, says the key was rejected", r.code === 3 && r.stderr.includes("rejected the key"), JSON.stringify(r));
    r = await jev(["yes-no", "BILLING", "y?"]);
    check("no card on file -> exit 3, names the credit card", r.code === 3 && r.stderr.includes("credit card"), JSON.stringify(r));
    r = await jev(["yes-no", "RATE", "y?"]);
    check("429 with retry-after-ms -> one retry, then success", r.code === 0 && rateHits === 2, JSON.stringify(r));
    r = await jev(["yes-no", "SLOW", "y?", "--timeout", "300"]);
    check("slow gateway -> exit 4 timeout", r.code === 4 && r.stderr.includes("timeout"), JSON.stringify(r));
    r = await jev(["yes-no", "GARBAGE", "y?"]);
    check("200 without the asked answers -> exit 4 bad response", r.code === 4 && r.stderr.includes("bad response"), JSON.stringify(r));
    r = await jev(["yes-no", "LEAK", "y?", "--json"]);
    check("a server that echoes the key -> exit 4, key redacted", r.code === 4 && r.stderr.includes("[redacted-key]") && !r.stderr.includes(TEST_KEY), JSON.stringify(r));
    r = await jev(["check"]);
    check("gateway check shows a key fingerprint, the balance and a working probe", r.code === 0 && r.stdout.includes("vck_...cdef") && r.stdout.includes("balance $4.99") && r.stdout.includes("model calls: OK"), JSON.stringify(r));

    console.log("== TypeSafe direct");
    r = await jev(["yes-no", "The message says ASAP.", "Is this urgent?"], { env: withTs });
    check("TypeSafe key alone -> TypeSafe provider, P(true) from 'noul'", r.code === 0 && r.stdout.includes("P(true)=0.800") && r.stdout.includes("jev-1.13.0 via typesafe"), JSON.stringify(r));
    check("TypeSafe request: /v1/systemone, model jev-latest in body, question sent as noul", last().url === "/v1/systemone" && last().body.model === "jev-latest" && last().body.questions.answer.type === "noul" && last().auth === `Bearer ${TS_KEY}`);
    r = await jev(["choose", "x", "pick", "a=first", "b=second"], { env: withTs });
    check("TypeSafe choice prints its confidence", r.code === 0 && r.stdout.includes("confidence=0.700"), JSON.stringify(r));
    r = await jev(["score", "x", "rate", "low", "mid", "high", "--json"], { env: withTs });
    let e1 = null; try { e1 = JSON.parse(r.stdout); } catch { /* checked below */ }
    check("TypeSafe score keeps legend and confidence; usage normalized to inputTokens", e1?.answers?.answer?.legend?.["1"] === "mid" && e1?.answers?.answer?.confidence === 0.9 && e1?.usage?.inputTokens === 40, r.stdout);
    r = await jev(["yes-no", "x", "y?"], { env: withBoth });
    check("both keys present -> TypeSafe is the default", r.code === 0 && last().url === "/v1/systemone", JSON.stringify(r));
    r = await jev(["yes-no", "x", "y?", "--provider", "gateway"], { env: withBoth });
    check("--provider gateway overrides the default", r.code === 0 && last().url === "/v4/ai/evaluation-model", JSON.stringify(r));
    r = await jev(["yes-no", "x", "y?"], { env: { ...withBoth, JEV_PROVIDER: "gateway" } });
    check("env JEV_PROVIDER=gateway overrides the default", r.code === 0 && last().url === "/v4/ai/evaluation-model", JSON.stringify(r));
    r = await jev(["yes-no", "x", "y?"], { env: { ...baseEnv, TYPESAFE_API_KEY: "ts_WRONG_000000000000" } });
    check("TypeSafe wrong key -> exit 3, names TYPESAFE_API_KEY", r.code === 3 && r.stderr.includes("TYPESAFE_API_KEY"), JSON.stringify(r));
    r = await jev(["yes-no", "TSCREDIT", "y?"], { env: withTs });
    check("TypeSafe out of credits (402) -> exit 3 credit problem", r.code === 3 && r.stderr.includes("credit"), JSON.stringify(r));
    r = await jev(["check"], { env: withTs });
    check("TypeSafe check lists models and runs the probe", r.code === 0 && r.stdout.includes("models jev-1.13.0") && r.stdout.includes("model calls: OK"), JSON.stringify(r));

    console.log("== secrecy across every run");
    const everything = allOutput.join("\n");
    check("neither full test key appears in any stdout or stderr", !everything.includes(TEST_KEY) && !everything.includes(TS_KEY));
  } finally {
    await new Promise((r) => srv.close(r));
  }
  if (checks < 30) { console.log(`FAIL: only ${checks} checks ran; a truncated run must not pass`); return 1; }
  console.log(`\n${checks - fails}/${checks} checks passed`);
  return fails ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
