---
type: llm
focus: trace
weight: 1
---

The generator now streams (messages.stream or equivalent) and calls abort() when a rule trips, instead of waiting for the full response.
