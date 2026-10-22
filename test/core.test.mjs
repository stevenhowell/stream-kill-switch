import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithKillSwitch, estimateTokens, decide, median } from "../scripts/lib/core.mjs";
import { FakeStream, chunksOf, fakeJudge } from "./helpers.mjs";

const GOOD = "def f(x):\n    return x + 1\n".repeat(60);           // ~1,500 chars ≈ 500 est. tokens
const BAD = "def f(x):\n    # TODO\n".repeat(8) + "raise NotImplementedError\n".repeat(50);

test("estimateTokens uses chars per token", () => {
  assert.equal(estimateTokens("a".repeat(300)), 100);
  assert.equal(estimateTokens("a".repeat(300), 4), 75);
  assert.equal(estimateTokens(""), 0);
});

test("decide picks the highest rule and compares to the threshold", () => {
  assert.deepEqual(decide({ a: 0.2, b: 0.9 }, 0.5), { kill: true, rule: "b", p: 0.9 });
  assert.deepEqual(decide({ a: 0.2, b: 0.4 }, 0.5), { kill: false, rule: "b", p: 0.4 });
  assert.deepEqual(decide({}, 0.5), { kill: false, rule: null, p: null });
  assert.equal(decide({ a: 0.5 }, 0.5).kill, true, "at the threshold counts as tripped");
});

test("median handles odd, even and empty", () => {
  assert.equal(median([5, 1, 3]), 3); assert.equal(median([1, 2, 3, 4]), 3); assert.equal(median([]), null);
});

test("kill mode: trips on the first checkpoint whose rule crosses the threshold and aborts once", async () => {
  let stream;
  const judge = fakeJudge({ score: ({ partial }) => ({ stub: /TODO|NotImplemented/.test(partial) ? 0.95 : 0.05 }) });
  const events = [];
  const record = await runWithKillSwitch({
    createStream: () => (stream = new FakeStream(chunksOf(BAD, 30), { overshootChunks: 2 })),
    params: {}, judge, rules: [{ id: "stub", question: "is a stub" }], mode: "kill", threshold: 0.5,
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(record.killed, true);
  assert.equal(record.kill.rule, "stub");
  assert.equal(record.kill.checkpointAt, 50, "first checkpoint is at 50 estimated tokens");
  assert.equal(stream.abortCalls, 1);
  assert.equal(record.usage, null, "an aborted stream has no usage");
  assert.equal(record.stopReason, "killed");
  assert.ok(record.kill.charsAfterAbort > 0, "chunks that arrive after abort are counted, not hidden");
  assert.ok(events.includes("kill") && events.includes("checkpoint") && events.at(-1) === "done");
});

test("shadow mode: judges at 50, 150, 250... and never aborts", async () => {
  let stream;
  const judge = fakeJudge({ score: () => ({ stub: 0.99 }) });
  const record = await runWithKillSwitch({
    createStream: () => (stream = new FakeStream(chunksOf(GOOD, 30))),
    params: {}, judge, rules: [{ id: "stub", question: "q" }], mode: "shadow",
  });
  assert.equal(record.killed, false);
  assert.equal(stream.abortCalls, 0);
  assert.ok(record.usage && record.usage.output_tokens > 0, "a finished stream keeps its real usage");
  assert.deepEqual(record.checkpoints.map((c) => c.at), [50, 150, 250, 350, 450]);
  assert.ok(record.checkpoints.every((c) => c.decision.kill === true), "decisions are recorded even when nothing is aborted");
});

test("a slow judge never overlaps itself; the pending checkpoint fires once it returns", async () => {
  const judge = fakeJudge({ latencyMs: 60, score: () => ({ r: 0.1 }) });
  let maxInFlight = 0, inFlight = 0;
  const wrapped = async (input) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); try { return await judge(input); } finally { inFlight--; } };
  const record = await runWithKillSwitch({
    createStream: () => new FakeStream(chunksOf(GOOD, 30), { delayMs: 2 }),
    params: {}, judge: wrapped, rules: [{ id: "r", question: "q" }], mode: "kill",
  });
  assert.equal(maxInFlight, 1);
  assert.ok(record.checkpoints.length >= 2 && record.checkpoints.length < 5, `got ${record.checkpoints.length} checkpoints`);
  assert.equal(record.killed, false);
});

test("shadow mode still records a pending verdict after the stream ends", async () => {
  const judge = fakeJudge({ latencyMs: 80, score: () => ({ r: 0.1 }) });
  const record = await runWithKillSwitch({
    createStream: () => new FakeStream(chunksOf(GOOD, 30), { delayMs: 1 }),
    params: {}, judge, rules: [{ id: "r", question: "q" }], mode: "shadow",
  });
  assert.equal(record.checkpoints.length, 2, "the first at 50, then one re-fire on the finished text");
  assert.ok(record.checkpoints[1].at > record.checkpoints[0].at);
});

test("off mode makes no judge calls", async () => {
  const judge = fakeJudge();
  const record = await runWithKillSwitch({ createStream: () => new FakeStream(chunksOf(GOOD, 30)), params: {}, judge, rules: [{ id: "r", question: "q" }], mode: "off" });
  assert.equal(judge.calls.length, 0);
  assert.equal(record.judgeCalls, 0);
  assert.ok(record.usage);
});

test("a judge error is recorded and the stream still finishes", async () => {
  const judge = async () => { throw new Error("jev down"); };
  const record = await runWithKillSwitch({ createStream: () => new FakeStream(chunksOf(GOOD, 30)), params: {}, judge, rules: [{ id: "r", question: "q" }], mode: "kill" });
  assert.equal(record.killed, false);
  assert.ok(record.judgeErrors.some((e) => /jev down/.test(e)));
  assert.ok(record.usage);
});

test("a stream error that is not an abort propagates", async () => {
  const createStream = () => ({ on() { return this; }, abort() {}, finalMessage: () => Promise.reject(new Error("overloaded")) });
  await assert.rejects(() => runWithKillSwitch({ createStream, params: {}, mode: "off" }), /overloaded/);
});

test("countTokens is used when given", async () => {
  const record = await runWithKillSwitch({ createStream: () => new FakeStream(chunksOf(GOOD, 30)), params: {}, mode: "off", countTokens: async (t) => t.length });
  assert.equal(record.countedTokens, GOOD.length);
});
