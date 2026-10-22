---
type: llm
focus: trace
weight: 1
---

The rules are separate yes/no statements for each fault (tone, refusal, JSON-instead-of-text), not one catch-all question, and the kill decision is made in the user's code from per-rule probabilities with a threshold.
