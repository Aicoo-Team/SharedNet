## What

<!-- One paragraph. What changes for a user, an agent, or an operator. -->

## Why

<!-- The problem, the decision, and what was rejected. Link the design doc or
     decision entry if one exists; if this changes the model, update the spec
     in the same PR. -->

## How it was verified

- [ ] `pnpm run typecheck` and `pnpm test` pass locally
- [ ] New behaviour has a test that fails without the change
- [ ] Touches `packages/db`: migration applies to an empty database (CI) **and**
      was rehearsed on a copy of real data if it changes existing rows
- [ ] Touches auth, origins, or credentials: the negative case is tested too
- [ ] Touches the UI: component tests updated; screenshot below if visual
- [ ] Docs updated (spec, decisions, TESTING/CONTRIBUTING) where the change
      alters what they say

## Deployment notes

<!-- Env vars added or changed? Hosted migration required before merge?
     Anything an operator must do? "None" is a fine answer. -->

## Risk and rollback

<!-- What breaks if this is wrong, and how it is undone. -->
