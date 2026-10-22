// Fake stream and judge for tests. No network.
export class FakeStream {
  constructor(chunks, { delayMs = 1, overshootChunks = 0, usage = null } = {}) {
    this.chunks = chunks; this.delayMs = delayMs; this.overshootChunks = overshootChunks;
    this.usage = usage ?? { output_tokens: Math.round(chunks.join("").length / 3) };
    this.aborted = false; this.abortCalls = 0; this.handlers = {};
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    queueMicrotask(() => this.run());
  }
  on(evt, cb) { (this.handlers[evt] ??= []).push(cb); return this; }
  emit(evt, ...a) { for (const cb of this.handlers[evt] ?? []) cb(...a); }
  abort() { this.abortCalls++; this.aborted = true; }
  async run() {
    let afterAbort = 0;
    for (const c of this.chunks) {
      await new Promise((r) => setTimeout(r, this.delayMs));
      if (this.aborted) { if (afterAbort++ >= this.overshootChunks) break; }
      this.emit("text", c);
    }
    if (this.aborted) { const e = new Error("Request was aborted."); e.name = "APIUserAbortError"; this.reject(e); }
    else this.resolve({ usage: this.usage, stop_reason: "end_turn", content: [{ type: "text", text: this.chunks.join("") }] });
  }
  finalMessage() { return this.done; }
}

export function chunksOf(text, size = 30) {
  const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out;
}

export function fakeJudge({ latencyMs = 5, score = () => ({}) } = {}) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    await new Promise((r) => setTimeout(r, latencyMs));
    return { rules: score(input), ms: latencyMs, choice: "keep" };
  };
  fn.calls = calls;
  return fn;
}
