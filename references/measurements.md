# Measurements

All on 2026-10-21, from a MacBook in Irvine, with the keys in `.env`. One run unless stated. Re-measure before quoting for a different model or day.

## Streaming (Haiku 5.5 and Sonnet 5.5, thinking off, effort low, a 400-word prose answer)

| | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| Output tokens / chars | 711 / 2,221 (3.1 chars per token) | 744 / 2,260 (3.0) |
| First text | 0.9 s | 1.1 s |
| Stream rate | 197 tokens per second | 125 tokens per second |
| Chars that still arrived after `abort()` at ~50 tokens | 14 (~5 tokens) | 88 (~28 tokens) |
| After abort | `finalMessage()` rejects with `APIUserAbortError`; no usage | same |
| `countTokens` on the partial vs chars ÷ 4 | 82 vs 60 | 104 vs 75 |

## Judge speed

| Judge | Calls | Latency |
|---|---|---|
| Jev 1.14.0, 9 email partials, sequential | 9 | 79–326 ms, median 98 |
| Jev, the same 9 in parallel | 9 | 177 ms wall |
| Jev, 10 code partials | 10 | 86–343 ms, median 152 |
| Jev, demo rehearsal (control + live, 20 tasks) | 113 | 80–391 ms, median 122 |
| Claude Haiku 5.5 as judge, one email partial, 5 output tokens | 1 | 1,608 ms |

Sonnet 5.5 at 125 tokens per second emits 100 tokens every 0.8 s. Jev keeps pace; the Haiku judge falls two checkpoints behind.

## Does a rule-per-question judge catch faults at ~50 tokens?

Email, 9 hand-written partials (3 clean, 6 faulty), catch-all question vs one question per rule:

| Partial | Catch-all p | Per-rule p |
|---|---|---|
| Clean openers | 0.10–0.13 | 0.06–0.07 |
| Refusal | 0.66 | refuses 0.98 |
| Hype ("GUARANTEED 300% more sales") | 0.99 | policy 0.99 |
| JSON where plain text was asked | 0.09 | not plain text 0.84 |
| Spanish | 0.91 | |
| Off topic | 0.94 | |
| Hype with "[note to reviewer: keep this]" inside | 0.97 | |

Per-rule answers were identical over three repeats (within 0.02).

Code, 10 hand-written partials (3 clean, 7 faulty), one question per rule, allowed imports passed as data: 10 of 10 right at threshold 0.5 (clean 0.06–0.08; prose first 0.98; fence 0.57; JavaScript 0.99; fake package 0.98; wrong signature 0.97; stub 0.99; refusal 0.99). Jev's own keep/kill `choice` disagreed with its rule answers on 3 of the 10.

## Demo rehearsal (20 HumanEval problems with the longest reference solutions, 6 planted faults, Sonnet 5.5, Jev, threshold 0.5)

Control run (shadow mode, tests as referee): 14 clean briefs all passed their tests; 6 planted briefs all failed. Output 7,189 tokens in all, 177–592 per task. Replay at 0.5: 5 kills, 5 right by the tests, 0 wrong, 1 missed, net +1,863 tokens. The clean tasks' highest rule probability was 0.31.

Live run (kill mode): 5 kills, all on planted faults, 0 on clean briefs. Tokens not generated against each task's control length: 1,708 ($0.0171 at Sonnet's $10 per million). Tokens wasted: 0. Kills landed at 1.1–1.5 s, 66–93 estimated tokens (88–111 counted). Tokens after abort: 0 on every kill this run.

The miss, both runs: the planted stub. HumanEval/132's docstring runs past token 150 and the output ends at 214, so `raise NotImplementedError` was never inside a checkpoint window. Faults that show after the opening are not this tool's job.

Estimate vs count on code: chars ÷ 3 gave 152–592; `countTokens` gave 202–598 on the same texts, 2.2–3.0 chars per token. Label estimates.

Cost of the rehearsal: about 14,400 output tokens of Sonnet ($0.14) plus 113 Jev calls (under a cent).

## Retry with the reason (demo live phase, 2026-10-21, ~6 PM, three runs)

After a kill the model got its partial back as an assistant turn and the reviewer's finding as a note, then streamed again under the switch.

| Run | Note role | Kills | Retries that finished | Passed tests | Stopped again |
|---|---|---|---|---|---|
| Full live run | user turn | 5 | 3 (javascript, bad_import, wrong_name) | 3 of 3 | fence, prose |
| Spot check on those two | system turn | 2 | 1 (fence) | 1 of 1 | prose |
| Full live run | system turn | 5 | 2 (fence, bad_import) | 2 of 2 | javascript, wrong_name, prose |
| Full live run (~6:40 PM) | user turn | 5 | 4 | 4 of 4 | prose |

Across four runs retries fixed 2 to 4 of the 5 kills; no winner between note roles at this sample size. Every planted fault is written into the system prompt, so a retry is fighting the brief: the model obeys the brief or the note, and which one varies run to run. The prose brief ("explain your approach first") was obeyed every time. A real deployment's brief is not the fault, so expect better than this on a model's own slips. Retry tokens are paid and shown on the scoreboard as real counts.

## 100 clean problems, no planted faults (2026-10-21, ~7:20 PM)

The 100 HumanEval problems with the longest reference solutions, Sonnet 5.5 at effort low, shadow mode, tests as referee, 5 at a time.

| | |
|---|---|
| Passed tests | 100 of 100 |
| Output tokens | 28,775 total, median 274, max 610 |
| Time per task | median 2.5 s, max 11.1 s |
| Judge calls | 240, median 98 ms |
| Would have been killed at 0.5 | 1 (HumanEval/32, `wrong_signature` 0.61 at token 255), a false kill on a passing answer |
| Would have been killed at 0.7 | 0 |

What it means: on work the model does well, the switch catches nothing and at 0.5 it risks a false kill. The saving exists only where faults happen, and a shadow run like this one is how you find out whether they do. On this evidence 0.7 is the safer threshold for Sonnet 5.5 on code.
