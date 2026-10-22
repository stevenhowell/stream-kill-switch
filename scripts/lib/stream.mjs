// The real stream: Anthropic SDK MessageStream. Kept apart so the core can be tested without it.
import Anthropic from "@anthropic-ai/sdk";

export function makeClaudeClient(options = {}) {
  return new Anthropic(options);
}

/** Returns createStream(params) for runWithKillSwitch. params are messages.stream() params. */
export function makeClaudeStreamFactory(client = makeClaudeClient()) {
  return (params) => client.messages.stream(params);
}

/** Real token count for a partial text, after the fact. An aborted stream returns no usage, so this is how you count. */
export function makeCountTokens(client, model) {
  return async (text) => {
    if (!text) return 0;
    const res = await client.messages.countTokens({ model, messages: [{ role: "user", content: text }] });
    return res.input_tokens;
  };
}
