// The referee: run generated code against the problem's own tests in a Python subprocess with a timeout.
// This executes model-written code on this machine. Fine for HumanEval on a laptop demo; use a sandbox in production.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runTests({ code, test, entry_point, timeoutMs = 5000, python = "python3" }) {
  const dir = mkdtempSync(join(tmpdir(), "killswitch-referee-"));
  const file = join(dir, "candidate.py");
  writeFileSync(file, `${code}\n\n${test}\n\ncheck(${entry_point})\n`);
  const t0 = performance.now();
  return new Promise((resolve) => {
    execFile(python, ["-I", file], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const ms = Math.round(performance.now() - t0);
      rmSync(dir, { recursive: true, force: true });
      if (!err) return resolve({ passed: true, status: "pass", ms, stderrTail: "" });
      const timedOut = err.killed || err.signal === "SIGTERM";
      resolve({ passed: false, status: timedOut ? "timeout" : "fail", ms, stderrTail: String(stderr ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-2).join(" | ").slice(0, 300) });
    });
  });
}
