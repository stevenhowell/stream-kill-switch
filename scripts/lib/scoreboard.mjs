// Scoreboard and replay. Every number here is arithmetic on recorded data; nothing is assumed.
//
// A task record for the scoreboard:
//   { id, planted: string|null,
//     control: { outputTokens: number|null (real usage), passed: true|false|null (referee), checkpoints: [...] (shadow judgements on the control stream) },
//     live:    { killed, kill: { atTokens, rule, p } | null, estTokens, elapsedMs } | null }

function maxRule(rules) {
  let top = { rule: null, p: -1 };
  for (const [rule, p] of Object.entries(rules ?? {})) if (typeof p === "number" && p > top.p) top = { rule, p };
  return top;
}

/** Was a kill on this task right? The referee (tests) decides when it ran; otherwise the planted label. */
export function killWasRight(task) {
  if (task.control && (task.control.passed === true || task.control.passed === false)) return task.control.passed === false;
  return Boolean(task.planted);
}

/** Replay the shadow judgements at any threshold. No new calls. */
export function replay(tasks, { threshold, overshootTokens = 0 } = {}) {
  const perTask = tasks.map((t) => {
    const cps = t.control?.checkpoints ?? [];
    let hit = null;
    for (const cp of cps) {
      const top = maxRule(cp.rules);
      if (top.p >= threshold) { hit = { at: cp.at, rule: top.rule, p: top.p, atMs: cp.sentAtMs != null && cp.ms != null ? cp.sentAtMs + cp.ms : null }; break; }
    }
    const full = t.control?.outputTokens ?? null;
    const killedAt = hit ? Math.min(hit.at + overshootTokens, full ?? Infinity) : null;
    const right = hit ? killWasRight(t) : null;
    const saved = hit && right && full !== null ? Math.max(0, full - killedAt) : 0;
    const wasted = hit && right === false ? killedAt : 0;
    const fullMs = t.control?.elapsedMs ?? null;
    const msSaved = hit && right && fullMs !== null && hit.atMs !== null ? Math.max(0, fullMs - hit.atMs) : 0;
    return { id: t.id, planted: t.planted ?? null, killed: Boolean(hit), killedAt, rule: hit?.rule ?? null, p: hit?.p ?? null, right, full, saved, wasted, msSaved };
  });
  const kills = perTask.filter((p) => p.killed);
  const tokensNotGenerated = perTask.reduce((s, p) => s + p.saved, 0);
  const tokensWasted = perTask.reduce((s, p) => s + p.wasted, 0);
  return {
    threshold,
    tasks: perTask.length,
    kills: kills.length,
    trueKills: kills.filter((p) => p.right === true).length,
    falseKills: kills.filter((p) => p.right === false).length,
    missed: perTask.filter((p) => !p.killed && killWasRight({ ...tasks.find((t) => t.id === p.id) })).length,
    tokensNotGenerated,
    tokensWasted,
    net: tokensNotGenerated - tokensWasted,
    msSaved: perTask.reduce((s, p) => s + p.msSaved, 0),
    perTask,
  };
}

/** Summarise a live (kill-mode) run against each task's control length. A live kill on a clean task counts as false: there is no way to check it. */
export function summarizeLive(tasks) {
  const perTask = tasks.filter((t) => t.live).map((t) => {
    const live = t.live;
    const full = t.control?.outputTokens ?? null;
    const right = live.killed ? Boolean(t.planted) : null;
    const saved = live.killed && right && full !== null ? Math.max(0, full - live.kill.atTokens) : 0;
    const wasted = live.killed && right === false ? live.kill.atTokens : 0;
    // Time: the control run's real wall-clock for this task minus when the kill landed. Waiting that did not happen.
    const fullMs = t.control?.elapsedMs ?? null;
    const msSaved = live.killed && right && fullMs !== null ? Math.max(0, fullMs - live.kill.atMs) : 0;
    const msWasted = live.killed && right === false ? live.kill.atMs : 0;
    const retryMs = live.retry?.elapsedMs ?? 0;
    const retryTokens = live.retry?.outputTokens ?? 0;
    return { id: t.id, planted: t.planted ?? null, killed: live.killed, killedAt: live.kill?.atTokens ?? null, killedAtMs: live.kill?.atMs ?? null, rule: live.kill?.rule ?? null, p: live.kill?.p ?? null, right, full, fullMs, saved, wasted, msSaved, msWasted, retryMs, retryTokens, elapsedMs: live.elapsedMs };
  });
  const kills = perTask.filter((p) => p.killed);
  const sum = (k) => perTask.reduce((s, p) => s + (p[k] ?? 0), 0);
  const tokensNotGenerated = sum("saved"), tokensWasted = sum("wasted");
  return {
    tasks: perTask.length,
    kills: kills.length,
    trueKills: kills.filter((p) => p.right === true).length,
    falseKills: kills.filter((p) => p.right === false).length,
    tokensNotGenerated,
    tokensWasted,
    net: tokensNotGenerated - tokensWasted,
    msSaved: sum("msSaved"),
    msWasted: sum("msWasted"),
    retryMs: sum("retryMs"),
    retryTokens: sum("retryTokens"),
    perTask,
  };
}

/** Dollars from tokens at a per-million output price. The price is an input, never a guess. */
export function dollars(tokens, pricePerMillionOutput) {
  if (typeof pricePerMillionOutput !== "number") return null;
  return (tokens / 1_000_000) * pricePerMillionOutput;
}
