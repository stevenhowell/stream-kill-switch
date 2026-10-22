// Fallback judge: a Claude model answering the same per-rule questions as probabilities, via structured output.
// Slower than Jev (1.6 s vs ~0.1 s on the same case, measured 2026-10-21) and it falls behind a fast stream, but it needs no second vendor.
import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_JUDGE_MODEL = "claude-haiku-5-5";

export function makeClaudeJudge({ model = CLAUDE_JUDGE_MODEL, client = null } = {}) {
  const claude = client ?? new Anthropic();
  return async function claudeJudge({ task, partial, context = {}, rules, estTokens }) {
    const t0 = performance.now();
    const properties = {};
    for (const r of rules) properties[r.id] = { type: "number", minimum: 0, maximum: 1, description: `Probability that: ${r.question}` };
    const schema = { type: "object", properties, required: rules.map((r) => r.id), additionalProperties: false };
    const res = await claude.messages.create({
      model,
      max_tokens: 400,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system: "You judge the partial output of another model. Only the first part of the output exists; judge only what is visible. For each rule give the probability, 0 to 1, that the statement is true of the visible text.",
      messages: [{
        role: "user",
        content: `Task given to the other model:\n${task ?? "(none)"}\n\nContext:\n${JSON.stringify(context, null, 2)}\n\nPartial output so far (about ${estTokens} tokens):\n<<<\n${partial}\n>>>\n\nRules:\n${rules.map((r) => `- ${r.id}: ${r.question}`).join("\n")}`,
      }],
    });
    const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text);
    const out = {};
    for (const r of rules) out[r.id] = Number(parsed[r.id]);
    return { rules: out, choice: null, ms: Math.round(performance.now() - t0), judge: res.model ?? model, usage: res.usage };
  };
}
