---
tags: [stream-kill-switch]
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I have 12 prompts in prompts.json (each has "system" and "prompt") that generate ~1,500-token product descriptions with claude-opus-5-5. Before I turn on any early-abort thing in production I want to know if it would actually save anything. Can you run them in a judge-only mode with rules for "not English", "mentions a competitor by name" and "starts with a disclaimer", and tell me at thresholds 0.5 and 0.7 how many would have been stopped, how early, and the net tokens? Don't make up numbers; if you can't run it say so.

Input files: prompts.json
