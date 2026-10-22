// Core of the kill switch: stream a generation, judge the partial text at checkpoints, abort when a rule trips.
// No SDK imports here, so the logic is testable with a fake stream and a fake judge.

export const DEFAULTS = Object.freeze({
  mode: "kill",          // "kill" aborts on a tripped rule; "shadow" judges but never aborts; "off" never judges
  threshold: 0.5,        // a rule trips when its p(yes) is at or above this
  firstCheckpoint: 50,   // estimated tokens before the first judgement
  every: 100,            // estimated tokens between judgements after the first
  stopAfter: Infinity,   // estimated tokens after which no more checkpoints fire: the judge re-reads the whole prefix each
                         // time, so judge input grows with output length, and faults that show early are already caught
  charsPerToken: 3,      // measured 3.0 (Sonnet 5.5) and 3.1 (Haiku 5.5) chars per token on English prose, 2026-10-21
});

/** Rough token count from characters. Measured: chars/4 undercounts by about a quarter; chars/3 is closer. */
export function estimateTokens(text, charsPerToken = DEFAULTS.charsPerToken) {
  return Math.round(text.length / charsPerToken);
}

/** The policy. Your code decides from the per-rule probabilities; the judge's own keep/kill choice is recorded only. */
export function decide(ruleProbabilities, threshold = DEFAULTS.threshold) {
  let top = null;
  for (const [id, p] of Object.entries(ruleProbabilities)) {
    if (typeof p !== "number" || Number.isNaN(p)) continue;
    if (!top || p > top.p) top = { rule: id, p };
  }
  if (!top) return { kill: false, rule: null, p: null };
  return { kill: top.p >= threshold, rule: top.rule, p: top.p };
}

export function isAbortError(err) {
  const name = err?.name ?? err?.constructor?.name ?? "";
  return name === "APIUserAbortError" || name === "AbortError" || /abort/i.test(String(err?.message ?? ""));
}

export function median(nums) {
  const a = nums.filter((n) => typeof n === "number").sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/**
 * Run one generation under the kill switch.
 *
 * createStream(params) must return something shaped like the Anthropic SDK's MessageStream:
 *   .on("text", cb)   cb(textDelta)
 *   .abort()
 *   .finalMessage()   resolves to the Message (with .usage and .stop_reason); rejects after abort()
 *
 * judge({ task, partial, context, rules, estTokens }) resolves to { rules: { [id]: p }, ms, choice?, judge? }.
 */
export async function runWithKillSwitch({
  createStream,
  params,
  judge,
  rules = [],
  context = {},
  task = null,
  mode = DEFAULTS.mode,
  threshold = DEFAULTS.threshold,
  firstCheckpoint = DEFAULTS.firstCheckpoint,
  every = DEFAULTS.every,
  stopAfter = DEFAULTS.stopAfter,
  charsPerToken = DEFAULTS.charsPerToken,
  countTokens = null,
  onEvent = () => {},
  now = () => performance.now(),
}) {
  if (!createStream) throw new Error("createStream is required");
  if (mode !== "off" && !judge) throw new Error(`judge is required in mode "${mode}"`);
  if (mode !== "off" && !rules.length) throw new Error("at least one rule is required unless mode is \"off\"");

  const t0 = now();
  const ms = () => Math.round(now() - t0);
  const est = (text) => estimateTokens(text, charsPerToken);

  let text = "";
  let firstTextMs = null;
  let nextAt = firstCheckpoint;
  let inFlight = null;
  let pending = false;
  let finished = false;
  let killed = false;
  let kill = null;
  let charsAfterAbort = 0;
  const checkpoints = [];
  const judgeErrors = [];

  const stream = createStream(params);

  const fire = (estTokens) => {
    const snapshot = text;
    const sentAtMs = ms();
    inFlight = Promise.resolve()
      .then(() => judge({ task, partial: snapshot, context, rules, estTokens }))
      .then((res) => {
        const decision = decide(res.rules, threshold);
        const cp = { at: estTokens, chars: snapshot.length, sentAtMs, ms: res.ms ?? ms() - sentAtMs, rules: res.rules, choice: res.choice ?? null, decision };
        checkpoints.push(cp);
        onEvent({ type: "checkpoint", ...cp });
        if (decision.kill && mode === "kill" && !killed && !finished) {
          killed = true;
          kill = { rule: decision.rule, p: decision.p, checkpointAt: estTokens, atTokens: est(text), atChars: text.length, atMs: ms(), judgeMs: cp.ms };
          try { stream.abort(); } catch (err) { judgeErrors.push(`abort: ${err?.message ?? err}`); }
          onEvent({ type: "kill", ...kill });
        }
      })
      .catch((err) => {
        judgeErrors.push(String(err?.message ?? err));
        onEvent({ type: "judge-error", error: String(err?.message ?? err), at: estTokens });
      })
      .finally(() => {
        inFlight = null;
        // A pending checkpoint re-fires on the latest text. After the stream has finished, only shadow mode still wants
        // the final verdict (it feeds the replay); in kill mode a late verdict could not abort anything.
        if (pending && !killed && (!finished || mode === "shadow")) { pending = false; fire(est(text)); }
      });
  };

  stream.on("text", (delta) => {
    if (firstTextMs === null) firstTextMs = ms();
    text += delta;
    onEvent({ type: "text", text: delta, estTokens: est(text) });
    if (killed) { charsAfterAbort += delta.length; return; }
    if (mode === "off") return;
    const e = est(text);
    if (e >= nextAt && nextAt <= stopAfter) {
      while (nextAt <= e) nextAt += every;
      if (inFlight) pending = true; else fire(e);
    }
  });

  let message = null;
  let error = null;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    if (!(killed && isAbortError(err))) error = err;
  }
  finished = true;
  while (inFlight) await inFlight;   // a pending re-fire can replace inFlight inside the previous call's finally
  if (error) throw error;

  const record = {
    mode,
    threshold,
    text,
    chars: text.length,
    estTokens: est(text),
    countedTokens: null,
    firstTextMs,
    elapsedMs: ms(),
    killed,
    kill: kill ? { ...kill, charsAfterAbort, tokensAfterAbort: Math.round(charsAfterAbort / charsPerToken) } : null,
    checkpoints,
    judgeCalls: checkpoints.length,
    judgeMsMedian: median(checkpoints.map((c) => c.ms)),
    judgeErrors,
    usage: message?.usage ?? null,         // real numbers; null after a kill, because an aborted stream returns no usage
    stopReason: message?.stop_reason ?? (killed ? "killed" : null),
  };
  if (countTokens) {
    try { record.countedTokens = await countTokens(text); } catch (err) { judgeErrors.push(`countTokens: ${err?.message ?? err}`); }
  }
  onEvent({ type: "done", record });
  return record;
}

/** The note the generator gets when it is retried after a kill. Plain words: what was seen, which rule, what to do instead. */
export function explainKill(record, rules) {
  const rule = rules.find((r) => r.id === record.kill?.rule);
  const why = rule ? rule.question : record.kill?.rule;
  return `Your previous attempt was stopped after about ${record.kill.atTokens} tokens. A reviewer found: "${why}" (probability ${record.kill.p.toFixed(2)}). Start again from the beginning and write the complete answer without that problem.`;
}

/**
 * Run under the kill switch and, when killed, retry with the reason fed back as conversation:
 * the partial as an assistant turn, then a user turn with the reviewer's finding. Up to maxRetries extra attempts.
 * Returns { attempts: [record...], final: record, retried: boolean, fixed: boolean|null }.
 */
export async function runWithRetry({ maxRetries = 1, explain = explainKill, noteRole = "user", ...opts }) {
  const attempts = [];
  let params = opts.params;
  for (let i = 0; i <= maxRetries; i++) {
    const record = await runWithKillSwitch({ ...opts, params, onEvent: (e) => opts.onEvent?.({ ...e, attempt: i }) });
    record.attempt = i;
    attempts.push(record);
    if (!record.killed) break;
    if (i === maxRetries) break;
    const note = explain(record, opts.rules ?? []);
    record.retryNote = note;
    opts.onEvent?.({ type: "retry", attempt: i + 1, note, previous: { rule: record.kill.rule, p: record.kill.p, atTokens: record.kill.atTokens } });
    // noteRole "user" works on every model. "system" sends the note as a mid-conversation system message (Opus 5.5, Sonnet 5.5,
    // Haiku 5.5 only; it must follow a user turn and be last). Three runs on 2026-10-21 showed no clear difference at n=5.
    const tail = noteRole === "system"
      ? [{ role: "user", content: "Start again from the beginning." }, { role: "system", content: note }]
      : [{ role: "user", content: note }];
    params = {
      ...params,
      messages: [...params.messages, { role: "assistant", content: record.text || "(nothing yet)" }, ...tail],
    };
  }
  const final = attempts.at(-1);
  return { attempts, final, retried: attempts.length > 1, fixed: attempts.length > 1 ? !final.killed : null };
}
