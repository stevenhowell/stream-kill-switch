#!/usr/bin/env node
// CLI for the kill switch.
//   node scripts/killswitch.mjs run --task task.json --rules rules.json [--mode kill|shadow|off] [--threshold 0.5]
//        [--model claude-opus-5-5] [--judge jev|claude] [--first 50] [--every 100] [--count-tokens] [--json] [--out record.json]
//   node scripts/killswitch.mjs replay --records tasks.json --threshold 0.5 [--overshoot 28]
// Keys: ANTHROPIC_API_KEY, and TYPESAFE_API_KEY for the Jev judge (node --env-file=.env ...).
import { readFileSync, writeFileSync } from "node:fs";
import { runWithKillSwitch, DEFAULTS } from "./lib/core.mjs";
import { makeClaudeClient, makeClaudeStreamFactory, makeCountTokens } from "./lib/stream.mjs";
import { makeJevJudge } from "./lib/judges/jev.mjs";
import { makeClaudeJudge } from "./lib/judges/claude.mjs";
import { replay } from "./lib/scoreboard.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function usage(code = 0) {
  console.error(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 6).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(code);
}

export function buildParams(task, { model, maxTokens }) {
  const params = {
    model: task.model ?? model ?? "claude-opus-5-5",
    max_tokens: task.max_tokens ?? maxTokens ?? 16000,
    messages: [{ role: "user", content: task.prompt }],
  };
  if (task.system) params.system = task.system;
  if (task.thinking) params.thinking = task.thinking;
  if (task.effort || task.output_config) params.output_config = { ...(task.output_config ?? {}), ...(task.effort ? { effort: task.effort } : {}) };
  return params;
}

export function pickJudge(name) {
  if (name === "claude") return makeClaudeJudge();
  if (!name || name === "jev") {
    if (!process.env.TYPESAFE_API_KEY) {
      if (name === "jev") throw new Error("TYPESAFE_API_KEY is not set. Use --judge claude, or set the key.");
      console.error("No TYPESAFE_API_KEY: using the Claude judge (slower; see SKILL.md).");
      return makeClaudeJudge();
    }
    return makeJevJudge();
  }
  throw new Error(`unknown judge "${name}"`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) usage(cmd ? 0 : 1);

  if (cmd === "replay") {
    const tasks = JSON.parse(readFileSync(args.records, "utf8"));
    const list = Array.isArray(tasks) ? tasks : tasks.tasks;
    const threshold = Number(args.threshold ?? DEFAULTS.threshold);
    const r = replay(list, { threshold, overshootTokens: Number(args.overshoot ?? 0) });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd !== "run") usage(1);
  if (!args.task || !args.rules) usage(1);
  const task = JSON.parse(readFileSync(args.task, "utf8"));
  const rules = JSON.parse(readFileSync(args.rules, "utf8"));
  const mode = args.mode ?? DEFAULTS.mode;
  const json = Boolean(args.json);
  const client = makeClaudeClient();
  const params = buildParams(task, { model: args.model, maxTokens: args["max-tokens"] ? Number(args["max-tokens"]) : undefined });
  const judge = mode === "off" ? null : pickJudge(args.judge);

  const record = await runWithKillSwitch({
    createStream: makeClaudeStreamFactory(client),
    params,
    judge,
    rules,
    task: task.task ?? task.prompt,
    context: task.context ?? {},
    mode,
    threshold: Number(args.threshold ?? DEFAULTS.threshold),
    firstCheckpoint: Number(args.first ?? DEFAULTS.firstCheckpoint),
    every: Number(args.every ?? DEFAULTS.every),
    countTokens: args["count-tokens"] ? makeCountTokens(client, params.model) : null,
    onEvent: (ev) => {
      if (json) { if (ev.type !== "done") console.log(JSON.stringify(ev)); return; }
      if (ev.type === "text") process.stdout.write(ev.text);
      else if (ev.type === "checkpoint") process.stderr.write(`\n[checkpoint ~${ev.at} tokens, ${ev.ms} ms] ${Object.entries(ev.rules).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ")}\n`);
      else if (ev.type === "kill") process.stderr.write(`\n[KILLED at ~${ev.atTokens} tokens (estimate): ${ev.rule} ${ev.p.toFixed(2)}, ${ev.atMs} ms]\n`);
      else if (ev.type === "judge-error") process.stderr.write(`\n[judge error] ${ev.error}\n`);
    },
  });

  const summary = {
    mode: record.mode, model: params.model, killed: record.killed, kill: record.kill,
    tokens: record.usage ? { outputTokens: record.usage.output_tokens, real: true } : { estTokens: record.estTokens, countedTokens: record.countedTokens, real: false },
    judgeCalls: record.judgeCalls, judgeMsMedian: record.judgeMsMedian, elapsedMs: record.elapsedMs, firstTextMs: record.firstTextMs, stopReason: record.stopReason,
  };
  if (json) console.log(JSON.stringify({ type: "done", ...summary, text: record.text, checkpoints: record.checkpoints }));
  else process.stderr.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  if (args.out) writeFileSync(args.out, JSON.stringify(record, null, 2));
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
