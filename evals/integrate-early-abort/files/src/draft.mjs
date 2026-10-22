// Outreach email generator. Called ~200 times a day.
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
const SYSTEM = "You write short, warm, plain-text outreach emails for a custom bottle company. No promises about results, no pressure, no discounts, English only.";

export async function draft(lead) {
  const res = await client.messages.create({
    model: "claude-sonnet-5-5",
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{ role: "user", content: `Write an outreach email to ${lead.name}, who runs ${lead.shop} in ${lead.city}. Notes: ${lead.notes}` }],
  });
  return res.content.find((b) => b.type === "text")?.text ?? "";
}
