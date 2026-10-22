// Demo server: 20 HumanEval problems streamed from Claude with Jev watching. One page, server-sent events, no framework.
// Run: node --env-file=.env demo/server.mjs   (PORT, DEMO_MODEL, DEMO_CONCURRENCY, DEMO_THRESHOLD optional)
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runWithKillSwitch, runWithRetry, DEFAULTS, median } from "../scripts/lib/core.mjs";
import { makeClaudeClient, makeClaudeStreamFactory, makeCountTokens } from "../scripts/lib/stream.mjs";
import { makeJevJudge, JEV_MODEL } from "../scripts/lib/judges/jev.mjs";
import { makeClaudeJudge, CLAUDE_JUDGE_MODEL } from "../scripts/lib/judges/claude.mjs";
import { replay, summarizeLive } from "../scripts/lib/scoreboard.mjs";
import { runTests } from "./referee.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.DEMO_MODEL ?? "claude-sonnet-5-5";
const THRESHOLD = Number(process.env.DEMO_THRESHOLD ?? DEFAULTS.threshold);
const CONCURRENCY = Number(process.env.DEMO_CONCURRENCY ?? 4);
// List prices per million output tokens, platform.claude.com, cached 2026-10-06. Shown on screen with that label.
const OUTPUT_PRICE = { "claude-opus-5-5": 20, "claude-sonnet-5-5": 10, "claude-haiku-5-5": 0.5 };

const tasks = JSON.parse(readFileSync(process.env.DEMO_TASKS ? process.env.DEMO_TASKS : here + "tasks.json", "utf8"));
const rules = JSON.parse(readFileSync(here + "rules.json", "utf8"));
const client = makeClaudeClient();
const createStream = makeClaudeStreamFactory(client);
const countTokens = makeCountTokens(client, MODEL);
const judgeName = process.env.TYPESAFE_API_KEY ? "jev" : "claude";
const judge = judgeName === "jev" ? makeJevJudge() : makeClaudeJudge();
const config = { model: MODEL, judge: judgeName === "jev" ? JEV_MODEL : CLAUDE_JUDGE_MODEL, threshold: THRESHOLD, concurrency: CONCURRENCY, firstCheckpoint: DEFAULTS.firstCheckpoint, every: DEFAULTS.every, outputPricePerMillion: OUTPUT_PRICE[MODEL] ?? null, priceNote: "list price per million output tokens, platform.claude.com, 2026-10-06" };

/** Generation params per model. Thinking is turned off where the model allows it so the stream is visible text from the first token. */
function genParams(task) {
  const p = { model: MODEL, max_tokens: 2000, system: task.system, messages: [{ role: "user", content: task.prompt }], output_config: { effort: "low" } };
  if (MODEL.startsWith("claude-sonnet-5-5")) p.thinking = { type: "between_tools" };
  else if (MODEL.startsWith("claude-haiku")) p.thinking = { type: "disabled" };
  return p;
}

let running = null; // { phase, done, total } while a phase runs, so a page that lost its connection can re-attach
const runsDir = process.env.DEMO_RUNS ? process.env.DEMO_RUNS.replace(/\/?$/, "/") : here + "runs/";
if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
const latestPath = runsDir + "latest.json";
// With no run yet, show the committed sample run (2026-10-21 rehearsal) so the page is not empty; the next control run replaces it.
function loadState(path, extra = {}) {
  if (!existsSync(path)) return null;
  const st = JSON.parse(readFileSync(path, "utf8"));
  // A saved run only counts if it is for this task set.
  const same = Array.isArray(st.tasks) && st.tasks.length === tasks.length && st.tasks.every((t, i) => t.id === tasks[i].id);
  return same ? { ...st, ...extra } : null;
}
let state = loadState(latestPath) ?? loadState(here + "sample-run.json", { sample: true });
function freshState() {
  return { config, startedAt: new Date().toISOString(), tasks: tasks.map((t) => ({ id: t.id, entry_point: t.entry_point, planted: t.planted, signature: t.context.required_signature, control: null, live: null })) };
}
function save() { writeFileSync(latestPath, JSON.stringify(state, null, 1)); }
function taskState(id) { return state.tasks.find((t) => t.id === id); }

function scoreboard() {
  const overshoot = median(state.tasks.filter((t) => t.live?.kill).map((t) => t.live.kill.tokensAfterAbort)) ?? 0;
  const haveControl = state.tasks.filter((t) => t.control);
  return {
    control: haveControl.length ? { done: haveControl.length, passed: haveControl.filter((t) => t.control.passed).length, failed: haveControl.filter((t) => !t.control.passed).length, tokens: haveControl.reduce((n, t) => n + (t.control.outputTokens ?? 0), 0), plantedFailed: haveControl.filter((t) => t.planted && !t.control.passed).length, planted: haveControl.filter((t) => t.planted).length } : null,
    replay: haveControl.length ? replay(haveControl, { threshold: state.config.threshold, overshootTokens: overshoot }) : null,
    live: state.tasks.some((t) => t.live) ? summarizeLive(state.tasks.filter((t) => t.control && t.live)) : null,
    overshootTokens: overshoot,
    judgeMsMedian: median(state.tasks.flatMap((t) => [...(t.control?.checkpoints ?? []), ...(t.live?.checkpoints ?? [])].map((c) => c.ms))),
    judgeCalls: state.tasks.reduce((n, t) => n + (t.control?.checkpoints?.length ?? 0) + (t.live?.checkpoints?.length ?? 0) + (t.live?.retry?.checkpoints?.length ?? 0), 0),
    retries: { tried: state.tasks.filter((t) => t.live?.retry).length, finished: state.tasks.filter((t) => t.live?.retry && !t.live.retry.killed).length, passed: state.tasks.filter((t) => t.live?.retry?.passed === true).length, tokens: state.tasks.reduce((n, t) => n + (t.live?.retry?.outputTokens ?? 0), 0) },
  };
}

/** A pool whose width can change while it runs: getN() is read before every start, so a pace change takes effect at the next task. */
function pool(items, getN, fn) {
  let i = 0, active = 0;
  return new Promise((resolve) => {
    const tick = () => {
      while (active < Math.max(1, getN()) && i < items.length) {
        active++;
        const item = items[i++];
        fn(item).catch(() => {}).finally(() => { active--; if (i >= items.length && active === 0) resolve(); else tick(); });
      }
      if (i >= items.length && active === 0) resolve();
    };
    tick();
  });
}

async function runPhase(phase, { limit, concurrency }, send) {
  if (phase === "control" || !state) state = freshState();
  const list = tasks.slice(0, limit);
  running = { phase, done: 0, total: list.length, startedAt: Date.now(), concurrency };
  send("start", { phase, config: state.config, tasks: list.map((t) => ({ id: t.id, entry_point: t.entry_point, planted: t.planted, signature: t.context.required_signature })) });
  await pool(list, () => running?.concurrency ?? concurrency, async (task) => {
    const ts = taskState(task.id);
    const mode = phase === "control" ? "shadow" : "kill";
    let record, retry = null;
    const onEvent = (ev) => {
      const attempt = ev.attempt ?? 0;
      if (ev.type === "text") send("text", { id: task.id, phase, attempt, text: ev.text, estTokens: ev.estTokens });
      else if (ev.type === "checkpoint") send("checkpoint", { id: task.id, phase, attempt, at: ev.at, ms: ev.ms, rules: ev.rules, decision: ev.decision });
      else if (ev.type === "kill") send("kill", { id: task.id, phase, attempt, rule: ev.rule, p: ev.p, atTokens: ev.atTokens, atMs: ev.atMs });
      else if (ev.type === "judge-error") send("judge-error", { id: task.id, phase, attempt, error: ev.error });
      else if (ev.type === "retry") send("retry-start", { id: task.id, phase, attempt, note: ev.note, previous: ev.previous });
    };
    const common = { createStream, params: genParams(task), judge, rules, task: task.task, context: task.context, mode, threshold: state.config.threshold, onEvent, maxMs: 60000, judgeTimeoutMs: 8000 };
    try {
      if (phase === "live") {
        // Live: on a kill, retry once with the reason fed back (the partial as an assistant turn, the reviewer's finding as a user turn).
        const out = await runWithRetry({ ...common, countTokens, maxRetries: 1 });
        record = out.attempts[0];
        if (out.retried) {
          const r = out.final;
          const referee = r.killed ? null : await runTests({ code: r.text, test: task.test, entry_point: task.entry_point });
          retry = { note: record.retryNote, killed: r.killed, kill: r.kill, text: r.text, outputTokens: r.usage?.output_tokens ?? null, estTokens: r.estTokens, elapsedMs: r.elapsedMs, checkpoints: r.checkpoints, passed: referee?.passed ?? null, referee };
          send("retry-done", { id: task.id, retry });
        }
      } else {
        record = await runWithKillSwitch(common);
      }
    } catch (err) {
      // Count it as done so the phase always ends; the card shows the error.
      running.done++;
      send("task-error", { id: task.id, phase, error: String(err?.message ?? err) });
      return;
    }
    const summary = { killed: record.killed, kill: record.kill, estTokens: record.estTokens, countedTokens: record.countedTokens, elapsedMs: record.elapsedMs, firstTextMs: record.firstTextMs, judgeCalls: record.judgeCalls, judgeMsMedian: record.judgeMsMedian, judgeErrors: record.judgeErrors, stopReason: record.stopReason, checkpoints: record.checkpoints, text: record.text };
    if (phase === "control") {
      const referee = await runTests({ code: record.text, test: task.test, entry_point: task.entry_point });
      ts.control = { ...summary, outputTokens: record.usage?.output_tokens ?? null, thinkingTokens: record.usage?.output_tokens_details?.thinking_tokens ?? null, usage: record.usage, passed: referee.passed, referee };
    } else {
      ts.live = { ...summary, usage: record.usage, retry };
    }
    save();
    running.done++;
    send("task-done", { id: task.id, phase, task: ts, scoreboard: scoreboard() });
  });
  running = null;
  send("phase-done", { phase, scoreboard: scoreboard(), tasks: state.tasks });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(here + "index.html")); }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (url.pathname === "/config") return json(200, config);
    if (url.pathname === "/lib/scoreboard.mjs") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(readFileSync(here + "../scripts/lib/scoreboard.mjs")); }
    if (url.pathname === "/rules") return json(200, rules);
    if (url.pathname === "/tasks") return json(200, tasks.map((t) => ({ id: t.id, entry_point: t.entry_point, planted: t.planted, signature: t.context.required_signature })));
    if (url.pathname === "/last") return json(200, state ? { ...state, scoreboard: scoreboard(), running } : { tasks: null, running });
    if (url.pathname === "/status") return json(200, { running });
    if (url.pathname === "/pace") {
      const n = Number(url.searchParams.get("concurrency"));
      if (!Number.isInteger(n) || n < 1 || n > 8) return json(400, { error: "concurrency must be 1–8" });
      if (running) running.concurrency = n;
      return json(200, { running, applied: Boolean(running) });
    }
    if (url.pathname === "/run") {
      const phase = url.searchParams.get("phase");
      if (phase !== "control" && phase !== "live") return json(400, { error: "phase must be control or live" });
      if (phase === "live" && !state?.tasks.some((t) => t.control)) return json(409, { error: "run the control phase first" });
      if (running) return json(409, { error: `a ${running.phase} run is already going (${running.done} of ${running.total}); reload the page to re-attach` });
      const limit = Number(url.searchParams.get("limit") ?? tasks.length);
      const concurrency = Number(url.searchParams.get("concurrency") ?? CONCURRENCY);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // The run finishes even if the page goes away; the page re-attaches through /last and /status.
      let closed = false; req.on("close", () => { closed = true; });
      const send = (event, data) => { if (!closed) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} } };
      const keepAlive = setInterval(() => send("ping", { t: Date.now() }), 10000);
      try { await runPhase(phase, { limit, concurrency }, send); } finally { clearInterval(keepAlive); }
      if (!closed) res.end();
      return;
    }
    json(404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(500, { error: String(err?.message ?? err) });
    else res.end();
  }
});
server.requestTimeout = 0; server.headersTimeout = 0; server.keepAliveTimeout = 0;
server.on("error", (err) => { if (err.code === "EADDRINUSE") { console.error(`Port ${PORT} is already in use: another copy of the demo is running. Use that one, or PORT=8788 npm run demo.`); process.exit(1); } throw err; });
server.listen(PORT, () => console.log(`kill switch demo on http://localhost:${PORT}  model=${MODEL} judge=${config.judge} threshold=${THRESHOLD}`));
