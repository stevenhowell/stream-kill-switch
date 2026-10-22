# stream-kill-switch

Judge a streaming Claude generation every ~100 tokens with a decision model and abort the bad ones before the output tokens are paid for. A Claude Code skill: read [SKILL.md](SKILL.md).

- `scripts/lib/core.mjs`: the checkpoint loop, no SDK imports, tested in `test/`
- `scripts/lib/judges/jev.mjs`: Jev judge (one `noul` question per rule); `judges/claude.mjs`: Claude Haiku fallback
- `scripts/lib/scoreboard.mjs`: replay any threshold from recorded checkpoints
- `scripts/killswitch.mjs`: CLI (`run`, `replay`)
- `demo/`: 20 HumanEval problems, 6 planted faults, tests as referee, one page

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY, and TYPESAFE_API_KEY for Jev
npm test
npm run demo           # http://localhost:8787
```

HumanEval (`demo/data/HumanEval.jsonl`) is from github.com/openai/human-eval, MIT licence. The demo runs generated code in a Python subprocess with a timeout; use a sandbox in production.
