---
tags: [stream-kill-switch]
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

my agent drafts about 200 outreach emails a day with claude sonnet, around 600 tokens each, and maybe 1 in 8 comes back in the wrong tone or starts with "I cannot" or dumps JSON instead of plain text. I pay for the whole thing every time and then regenerate. can you add an early abort to my generator so the bad ones get stopped after the first few lines? my generator is in src/draft.mjs (it calls client.messages.create with a system prompt and returns the text). keep it honest about what numbers are estimates.

Input files: src/draft.mjs
