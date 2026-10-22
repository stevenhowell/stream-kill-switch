// Jev judge: one noul question per rule, the generation's task and any context passed as state.
// Jev is not trained by you. The rules are the policy; write them as questions a reader could answer from the visible text.
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

export const JEV_MODEL = "jev-1.14.0"; // pinned: the jev-latest alias moves

export function makeJevJudge({ model = JEV_MODEL, client = null } = {}) {
  const jev = client ?? new TypeSafeClient();
  return async function jevJudge({ task, partial, context = {}, rules, estTokens }) {
    const t0 = performance.now();
    const questions = {};
    for (const r of rules) {
      if (r.id === "route") throw new Error('rule id "route" is reserved');
      questions[r.id] = noul(r.question);
    }
    // Listed keep-first on purpose: Jev favours the first option, so the bias runs toward not killing. Recorded, never trusted.
    questions.route = choice("What should happen to this generation?", { keep: "Let it keep generating", kill: "Stop it now" });
    const res = await jev.systemOne({
      model,
      state: {
        task,
        ...context,
        partial_output_so_far: partial,
        note: `The output is still being generated; only the first ~${estTokens} tokens exist. Judge only what is visible.`,
      },
      questions,
    });
    const out = {};
    for (const r of rules) out[r.id] = res.answers[r.id].noul;
    return {
      rules: out,
      choice: res.answers.route.choice,
      choiceConfidence: res.answers.route.confidence,
      ms: Math.round(performance.now() - t0),
      judge: res.model ?? model,
    };
  };
}
