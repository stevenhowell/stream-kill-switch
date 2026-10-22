---
tags: [stream-kill-switch]
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

quick q: our classifier endpoint returns like 60-80 output tokens per call (a label plus a one-line reason) on haiku. should we add that mid-stream kill switch thing to it to save money? we do about 2M calls a month
