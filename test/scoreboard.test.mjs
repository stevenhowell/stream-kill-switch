import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, summarizeLive, killWasRight, dollars } from "../scripts/lib/scoreboard.mjs";

const cp = (at, p) => ({ at, rules: { stub: p } });
const tasks = [
  { id: "clean", planted: null, control: { outputTokens: 700, passed: true, checkpoints: [cp(50, 0.05), cp(150, 0.06)] } },
  { id: "planted", planted: "stub", control: { outputTokens: 600, passed: false, checkpoints: [cp(50, 0.97)] } },
  { id: "false-kill", planted: null, control: { outputTokens: 500, passed: true, checkpoints: [cp(50, 0.2), cp(150, 0.8)] } },
  { id: "missed", planted: "prose", control: { outputTokens: 400, passed: false, checkpoints: [cp(50, 0.1)] } },
];

test("killWasRight: the referee wins over the planted label", () => {
  assert.equal(killWasRight({ planted: null, control: { passed: false } }), true);
  assert.equal(killWasRight({ planted: "x", control: { passed: true } }), false);
  assert.equal(killWasRight({ planted: "x", control: { passed: null } }), true);
  assert.equal(killWasRight({ planted: null, control: {} }), false);
});

test("replay at 0.5 counts kills, false kills, tokens and net", () => {
  const r = replay(tasks, { threshold: 0.5 });
  assert.equal(r.kills, 2); assert.equal(r.trueKills, 1); assert.equal(r.falseKills, 1); assert.equal(r.missed, 1);
  assert.equal(r.tokensNotGenerated, 550, "600 - 50");
  assert.equal(r.tokensWasted, 150);
  assert.equal(r.net, 400);
});

test("replay at a higher threshold drops the false kill, overshoot reduces the saving", () => {
  const r = replay(tasks, { threshold: 0.9, overshootTokens: 28 });
  assert.equal(r.kills, 1); assert.equal(r.falseKills, 0);
  assert.equal(r.tokensNotGenerated, 600 - 78);
});

test("summarizeLive counts a live kill on a clean task as false", () => {
  const live = [
    { id: "a", planted: "stub", control: { outputTokens: 600 }, live: { killed: true, kill: { atTokens: 80, rule: "stub", p: 0.9 }, elapsedMs: 1500 } },
    { id: "b", planted: null, control: { outputTokens: 700 }, live: { killed: true, kill: { atTokens: 60, rule: "stub", p: 0.6 }, elapsedMs: 1200 } },
    { id: "c", planted: null, control: { outputTokens: 500 }, live: { killed: false, kill: null, elapsedMs: 6000 } },
  ];
  const s = summarizeLive(live);
  assert.equal(s.kills, 2); assert.equal(s.trueKills, 1); assert.equal(s.falseKills, 1);
  assert.equal(s.tokensNotGenerated, 520); assert.equal(s.tokensWasted, 60); assert.equal(s.net, 460);
});

test("dollars needs a price", () => {
  assert.equal(dollars(1_000_000, 10), 10); assert.equal(dollars(500, null), null);
});

test("summarizeLive adds time saved from the control's real elapsed time", () => {
  const live = [
    { id: "a", planted: "stub", control: { outputTokens: 600, elapsedMs: 5000 }, live: { killed: true, kill: { atTokens: 80, atMs: 1200, rule: "stub", p: 0.9 }, elapsedMs: 1300, retry: { elapsedMs: 2500, outputTokens: 400, killed: false } } },
    { id: "b", planted: null, control: { outputTokens: 700, elapsedMs: 6000 }, live: { killed: true, kill: { atTokens: 60, atMs: 900, rule: "stub", p: 0.6 }, elapsedMs: 1000 } },
  ];
  const s = summarizeLive(live);
  assert.equal(s.msSaved, 3800); assert.equal(s.msWasted, 900); assert.equal(s.retryMs, 2500); assert.equal(s.retryTokens, 400);
});

test("replay estimates time saved from checkpoint timing", () => {
  const r = replay([{ id: "x", planted: "stub", control: { outputTokens: 600, elapsedMs: 5000, passed: false, checkpoints: [{ at: 50, sentAtMs: 800, ms: 120, rules: { stub: 0.97 } }] } }], { threshold: 0.5 });
  assert.equal(r.msSaved, 5000 - 920);
});
