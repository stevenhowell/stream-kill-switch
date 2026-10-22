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

const tasks = JSON.parse(readFileSync(here + "tasks.json", "utf8"));
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

const runsDir = here + "runs/";
if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
const latestPath = runsDir + "latest.json";
// With no run yet, show the committed sample run (2026-10-21 rehearsal) so the page is not empty; the next control run replaces it.
let state = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, "utf8")) : existsSync(here + "sample-run.json") ? { ...JSON.parse(readFileSync(here + "sample-run.json", "utf8")), sample: true } : null;
function freshState() {
  return { config, startedAt: new Date().toISOString(), tasks: tasks.map((t) => ({ id: t.id, entry_point: t.entry_point, planted: t.planted, signature: t.context.required_signature, control: null, live: null })) };
}
function save() { writeFileSync(latestPath, JSON.stringify(state, null, 1)); }
function taskState(id) { return state.tasks.find((t) => t.id === id); }

function scoreboard() {
  const overshoot = median(state.tasks.filter((t) => t.live?.kill).map((t) => t.live.kill.tokensAfterAbort)) ?? 0;
  const haveControl = state.tasks.filter((t) => t.control);
  return {
    replay: haveControl.length ? replay(haveControl, { threshold: state.config.threshold, overshootTokens: overshoot }) : null,
    live: state.tasks.some((t) => t.live) ? summarizeLive(state.tasks.filter((t) => t.control && t.live)) : null,
    overshootTokens: overshoot,
    judgeMsMedian: median(state.tasks.flatMap((t) => [...(t.control?.checkpoints ?? []), ...(t.live?.checkpoints ?? [])].map((c) => c.ms))),
    judgeCalls: state.tasks.reduce((n, t) => n + (t.control?.checkpoints?.length ?? 0) + (t.live?.checkpoints?.length ?? 0) + (t.live?.retry?.checkpoints?.length ?? 0), 0),
    retries: { tried: state.tasks.filter((t) => t.live?.retry).length, finished: state.tasks.filter((t) => t.live?.retry && !t.live.retry.killed).length, passed: state.tasks.filter((t) => t.live?.retry?.passed === true).length, tokens: state.tasks.reduce((n, t) => n + (t.live?.retry?.outputTokens ?? 0), 0) },
  };
}

async function pool(items, n, fn, shouldStop) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !shouldStop()) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

async function runPhase(phase, { limit, concurrency }, send, shouldStop) {
  if (phase === "control" || !state) state = freshState();
  const list = tasks.slice(0, limit);
  send("start", { phase, config: state.config, tasks: list.map((t) => ({ id: t.id, entry_point: t.entry_point, planted: t.planted, signature: t.context.required_signature })) });
  await pool(list, concurrency, async (task) => {
    const ts = taskState(task.id);
    const mode = phase === "control" ? "shadow" : "kill";
    let record, retry = null;
    const onEvent = (ev) => {
      const attempt = ev.attempt ?? 0;
      if (ev.type === "text") send("text", { id: task.id, phase, attempt, text: ev.text, estTokens: ev.estTokens });
      else if (ev.type === "checkpoint") send("checkpoint", { id: task.id, phase, attempt, at: ev.at, ms: ev.ms, rules: ev.rules, decision: ev.decision });
      else if (ev.type === "kill") send("kill", { id: task.id, phase, attempt, rule: ev.rule, p: ev.p, atTokens: ev.atTokens, atMs: ev.atMs });
      else if (ev.type === "judge-error") send("judge-error", { id: task.id, phase, attempt, error: ev.error });
    };
    const common = { createStream, params: genParams(task), judge, rules, task: task.task, context: task.context, mode, threshold: state.config.threshold, onEvent };
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
    send("task-done", { id: task.id, phase, task: ts, scoreboard: scoreboard() });
  }, shouldStop);
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
    if (url.pathname === "/last") return json(200, state ? { ...state, scoreboard: scoreboard() } : { tasks: null });
    if (url.pathname === "/run") {
      const phase = url.searchParams.get("phase");
      if (phase !== "control" && phase !== "live") return json(400, { error: "phase must be control or live" });
      if (phase === "live" && !state?.tasks.some((t) => t.control)) return json(409, { error: "run the control phase first" });
      const limit = Number(url.searchParams.get("limit") ?? tasks.length);
      const concurrency = Number(url.searchParams.get("concurrency") ?? CONCURRENCY);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      let closed = false; req.on("close", () => { closed = true; });
      const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      await runPhase(phase, { limit, concurrency }, send, () => closed);
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
server.listen(PORT, () => console.log(`kill switch demo on http://localhost:${PORT}  model=${MODEL} judge=${config.judge} threshold=${THRESHOLD}`));
