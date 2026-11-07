# Skills

One folder per skill pack: `skill.json` (the contract) and `evals/cases.jsonl` (public cases). The plan, the
contract fields and the rules between skills: [docs/skills-plan.md](../docs/skills-plan.md). The registry that
checks them: `services/skills/registry.ts`; the checks: `services/skills/checks.ts`.

Phase 0: the manifests describe and measure what the controller does today; they do not route requests yet.

Adding or changing behaviour:
1. Write the case first (it should be red): a request, `root` (`repo`, `home` or `none`) and `expect` with
   programmatic checks only (`skill`, `reasonCode`, `status`, `answer`/`notAnswer` regexes, `lang`, `latencyMs`).
   Cases with personal paths or documents go to `~/OnBud/runtime/evals/private/*.jsonl`, never here.
2. Change one skill.
3. `npm run skills:eval -- --private --baseline <previous results.jsonl>`: the new case is green and nothing that
   was green turned red; `npm test` passes.
