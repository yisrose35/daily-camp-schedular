# Tests

These are Node-based regression tests for the audit-hardened code paths.
They use Node's built-in test runner (`node --test`); no extra deps.

## Running

```bash
# All tests
npm test

# Or directly
node --test tests/

# A specific test file
node --test tests/auto_rules_check.test.js
```

## What's covered

### Auto-generation pipeline (Slice 3)
- `auto_rules_check.test.js` — `rules.js` cooldown gate. Asserts the anchor-type fix (Slice 3 N4 / third-pass batch) holds: a Lunch anchor write is not blocked by a "no Sport within 30 min of Lunch" cooldown.
- `auto_rotation_determinism.test.js` — `rotation_engine.js` tie-breaker (Slice 3 N8). Asserts identical inputs produce identical rankings. Math.random() in tie-break is forbidden.
- `auto_commit_write_guard.test.js` — `auto_solver_engine.js` `commitWriteIfLegal` central trust point. Asserts the guard rejects illegal writes (out-of-grade, cooldown violations) and invalidates the rotation cache on success.
- `auto_feasibility.test.js` — Phase A diagnostic. Asserts pre-flight `check()` correctly identifies Cause 1 (pool exhaustion), Cause 2 (window deficit), Cause 3 (special contention), produces deterministic output, and `forensics()` correctly categorizes Free blocks by `_freeReason` and cross-references against the pre-flight report.

### Cloud sync + persistence (Slice 1)
- (existing) `calendar_delete_reset.test.js` — erase / reset paths.

### Cross-cutting
- (existing) `period_packer.test.js`, `post_edit_autogen.test.js`, `travel_time.test.js`

## When to run

**Before every commit to scheduler / solver / rules / rotation files.**

The auto-pipeline tests above are the regression net for the most-audited
code in the repo. Slice 3 had 3 audit cycles + a fourth batch; without
these tests the next refactor will silently re-introduce the same class
of bugs.

## Adding a test

Follow the pattern in `auto_rules_check.test.js`:

1. `node:test` + `node:assert/strict`.
2. Build a minimal `vm` sandbox with stubbed browser globals.
3. `loadInto('module.js', ctx)` to evaluate the app file inside the sandbox.
4. Read back the exposed `window.X` to test against it.

The convention exists because the app is a browser-loaded multi-file system
with no module boundaries. Tests carve out a sandbox per file and stub the
globals each module needs.
