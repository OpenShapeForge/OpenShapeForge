<!--
Thanks for contributing. Keep changes to one logical thing per PR.
Do NOT include secrets or internal references (see AGENTS.md). By contributing
you agree your contribution is licensed under the project's license
(inbound = outbound; see LICENSE, Business Source License 1.1).
-->

## What and why

<!-- What does this change, and why? Link the issue it addresses. -->

Closes #

## How it was verified

<!-- Which gates you ran and their result. Paste " N pass / N fail" lines. -->

## Checklist

- [ ] One logical change; diff is reviewable.
- [ ] No secrets, credentials, or internal/third-party references in code,
      comments, commits, or this description.
- [ ] Generated artifacts were **not** hand-edited — I changed the source
      (YAML / compiler / plugin) and ran `bun run generate`.
- [ ] Gates pass (`set -o pipefail`; read the `N pass / N fail` lines):
  - [ ] `bun run check:generated`
  - [ ] `bun run check:authoring-local`
  - [ ] `bun run check:notices` (ran `bun run notices` if I changed dependencies)
  - [ ] `bun run typecheck:compiler` and `bun run typecheck:api`
  - [ ] `bun run test:compiler`
  - [ ] `bun run test:e2e` (Postgres up)
  - [ ] `cd apps/api && bun test src/db` (migrations + drift)
  - [ ] `bun run test:perf` (only if touching the API hot path)
- [ ] New entity? Bumped `expectedGeneratedCrudEntityCount` and ran
      `bun run db:migrate`.
- [ ] Applied migrations are immutable — I did not edit one that already ran.
- [ ] Nothing a generator/plugin emits depends on time or randomness
      (determinism gate).
