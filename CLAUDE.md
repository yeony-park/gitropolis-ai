# CLAUDE.md

<!--
Adapted from Karpathy-Inspired Claude Code Guidelines:
https://github.com/multica-ai/andrej-karpathy-skills

Original project metadata lists forrestchang as the author and MIT as the license.
Modified for Gitropolis to include project-specific commit and branch conventions.
-->

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Commit Convention

**Use consistent, readable commit messages.**

When creating a commit:

- Follow project-specific commit instructions in `CONTRIBUTING.md` when present.
- Otherwise, use the format `<type>: <short description>`.
- Use one of these types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, or `chore`.
- Choose the type that best reflects the primary purpose of the change.
- Keep the description concise and specific.

## 6. Branch Convention

**Match branch prefixes to the commit convention.**

When creating a branch:

- Use the format `<type>/<short-kebab-case-description>`.
- Use one of these types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, or `chore`.
- Use `feat/`, not `feature/`.
- Do not prepend tool or agent names such as `codex/` or `agent/`.
- Keep the description concise and specific.

## 7. Local Project Documents

- If `docs/local/` exists, read `docs/local/DESIGN.md` and `docs/local/PROGRESS.md` before planning project work.
- For data collection, schemas, scoring, or GitHub API work, read `docs/DATA_SPEC.md`.
- Also read `docs/local/DATA_COLLECTION_NOTES.md` when it exists, but treat it as experimental rather than as the public contract.
- Move only implemented and verified data behavior from local notes into `docs/DATA_SPEC.md`.
- Update `docs/local/PROGRESS.md` after completing a meaningful development milestone.
- Do not commit files under `docs/local/`.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
