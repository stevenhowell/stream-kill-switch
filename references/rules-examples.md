# Rule sets

Rules are `[{ id, question }]`. Each question is a yes/no statement a reader could judge from the visible partial text plus the `context` you pass. Probabilities come back per rule; the code kills at or above the threshold.

## Code (used by the demo; 10 of 10 planted faults caught at ~50 tokens, median 152 ms)

```json
[
  { "id": "not_code", "question": "The partial output starts with prose, an explanation, or a markdown code fence instead of raw Python code" },
  { "id": "not_python", "question": "The visible code is not Python" },
  { "id": "bad_import", "question": "The visible code imports a module that is not in allowed_imports" },
  { "id": "wrong_signature", "question": "The visible code defines the main function with a name or parameters that differ from required_signature" },
  { "id": "stub", "question": "The visible code is a stub: a TODO, pass, or NotImplementedError instead of an implementation" },
  { "id": "refuses", "question": "The partial output declines the task or asks the user a question instead of writing the function" }
]
```
Context: `{ "allowed_imports": [...], "required_signature": "def f(x: int) -> int:" }`.

## Outreach email (the email flavour; refusal 0.98, hype 0.99, JSON-instead-of-text 0.84 with these, 0.09 with a catch-all)

```json
[
  { "id": "not_plain_text", "question": "The partial output is not a plain-text email (for example it is JSON, a list of fields, or code)" },
  { "id": "not_english", "question": "The partial output is not written in English" },
  { "id": "refuses", "question": "The partial output refuses, declines, or asks the user for more information instead of drafting the email" },
  { "id": "breaks_policy", "question": "The partial output promises results, pressures the reader, or offers a discount" }
]
```
Context: `{ "sender_policy": "plain-text email in English, no promises about results, no pressure tactics, no discounts" }`.

## Structured output

```json
[
  { "id": "not_json", "question": "The partial output does not begin with a JSON object or array" },
  { "id": "wrong_shape", "question": "The visible JSON keys are not the ones listed in required_keys" },
  { "id": "prose_first", "question": "The partial output begins with an explanation or a markdown fence before the JSON" }
]
```
Context: `{ "required_keys": ["subject", "body", "cta"] }`. For strict JSON, prefer the API's structured outputs (`output_config.format`) and keep the switch for prose faults inside string fields.

## Writing new rules

- Name the fault, not the goal: "is not English", not "is good".
- If the rule needs a fact (an allowed list, a signature, a word limit), pass it in `context` and name it in the question.
- Test each rule on three clean openers and one planted fault before trusting it. The CLI in `--mode shadow` with `--json` prints every checkpoint.
