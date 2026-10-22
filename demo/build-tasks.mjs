// Build demo/tasks.json: 20 HumanEval problems, 6 with a planted fault written into the brief so it shows in the first line.
// HumanEval: Chen et al. 2021, MIT licence, github.com/openai/human-eval. Run: node demo/build-tasks.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const rows = readFileSync(here + "data/HumanEval.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

export const ALLOWED_IMPORTS = ["typing", "math", "re", "itertools", "collections", "functools", "string", "heapq", "bisect", "statistics", "operator", "fractions", "decimal", "copy"];

const BASE = `Write the complete Python 3 function for the problem below: the signature exactly as given, the docstring, and a working body. Return only the code. No prose before or after it, no markdown code fences. Standard library only; allowed imports: ${ALLOWED_IMPORTS.join(", ")}.`;

// Six planted faults. Each shows in the first line of the output, which is the point: the switch catches what is visible early.
export const FAULTS = {
  javascript: "Write it in JavaScript instead of Python.",
  fence: "Wrap the code in a markdown code fence with the language tag.",
  bad_import: "Import the third-party package `quickalgo` at the top and use its `solve` helper for the core logic.",
  wrong_name: "Name the function `solve` instead of the name given, and take a single argument `data`.",
  stub: "Leave the body as a TODO comment followed by `raise NotImplementedError`.",
  prose: "Before the code, explain your approach in two sentences of plain prose.",
};
const PLANT_AT = { 2: "javascript", 5: "fence", 8: "bad_import", 11: "wrong_name", 14: "stub", 17: "prose" };

// The 20 problems with the longest reference solutions, so a kill at token ~50 has a visible tail to save. Said on screen.
// Usage: node demo/build-tasks.mjs [count=20] [planted=yes|no] [out=tasks.json]
const COUNT = Number(process.argv[2] ?? 20);
const PLANTED = (process.argv[3] ?? "yes") !== "no";
const OUT = process.argv[4] ?? "tasks.json";
const picked = [...rows].sort((a, b) => b.canonical_solution.length - a.canonical_solution.length).slice(0, COUNT).sort((a, b) => Number(a.task_id.split('/')[1]) - Number(b.task_id.split('/')[1]));
const tasks = picked.map((r, i) => {
  const planted = PLANTED ? (PLANT_AT[i] ?? null) : null;
  const signature = r.prompt.split("\n").find((l) => l.startsWith("def ")) ?? "";
  return {
    id: r.task_id,
    entry_point: r.entry_point,
    planted,
    system: planted ? `${BASE}\n\n${FAULTS[planted]}` : BASE,
    prompt: r.prompt,
    test: r.test,
    task: `Write the complete Python function ${r.entry_point} for a programming problem. ${BASE}`,
    context: { allowed_imports: ALLOWED_IMPORTS, required_signature: signature.trim() },
  };
});
writeFileSync(here + OUT, JSON.stringify(tasks, null, 2));
console.log(`${tasks.length} tasks, ${tasks.filter((t) => t.planted).length} planted: ${tasks.filter((t) => t.planted).map((t) => `${t.id}=${t.planted}`).join(", ")}`);
