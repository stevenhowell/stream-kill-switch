# stream-kill-switch

Judge a streaming Claude generation every ~100 tokens with a decision model and abort the bad ones before the output tokens are paid for. A Claude Code skill: read [SKILL.md](SKILL.md).

Output tokens cost five times input on every current Claude model. When a generation goes wrong in its first line (wrong language, prose where code was asked, a refusal, a stub, a banned claim), every token after it is wasted. The switch streams the generation, asks a judge one yes/no question per rule at checkpoints, and aborts the stream the moment a rule trips. Your code decides from the probabilities; the judge never does. Shadow mode judges without aborting, so you can measure whether the switch would pay for a workload before turning it on.

Built on 2026-10-21 for the OC Lightning Hackathon (Decisions + LLMs) in Irvine. Every number in [SKILL.md](SKILL.md) and [references/measurements.md](references/measurements.md) was measured that day.

## Install the skill

Claude Code, from this repo as a marketplace:

```
/plugin marketplace add stevenhowell/stream-kill-switch
/plugin install stream-kill-switch@stevenhowell
```

Or clone it into your skills folder:

```bash
git clone https://github.com/stevenhowell/stream-kill-switch ~/.claude/skills/stream-kill-switch
```

Either way, Claude Code loads the skill on the next session. Ask for an early abort, a mid-stream guardrail, or whether a kill switch would pay off for your workload.

## Run the code

- `scripts/lib/core.mjs`: the checkpoint loop, no SDK imports, tested in `test/`
- `scripts/lib/judges/jev.mjs`: Jev judge (one `noul` question per rule); `judges/claude.mjs`: Claude Haiku fallback
- `scripts/lib/scoreboard.mjs`: replay any threshold from recorded checkpoints
- `scripts/killswitch.mjs`: CLI (`run`, `replay`)
- `demo/`: 20 HumanEval problems, 6 planted faults, tests as referee, one page
- `evals/`: cases for `claude plugin eval`

Requirements: Node 22 or newer; `python3` on the path for the demo's referee; an `ANTHROPIC_API_KEY`, and a `TYPESAFE_API_KEY` for the Jev judge (without it the Claude Haiku judge is used, which is slower).

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY, and TYPESAFE_API_KEY for Jev
npm test
npm run demo           # http://localhost:8787
```

HumanEval (`demo/data/HumanEval.jsonl`) is from github.com/openai/human-eval, MIT licence (see `demo/data/LICENSE-HumanEval`). The demo runs generated code in a Python subprocess with a timeout; use a sandbox in production.

## Licence

MIT. See [LICENSE](LICENSE).
