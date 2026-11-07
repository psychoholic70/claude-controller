---
name: claude-controller
description: Use Claude (Opus) from inside Codex as an independent controller that tests, reviews, verifies and, only when asked, fixes a project Codex built. Trigger when the user says "let Claude check/test/review this", "second opinion from Claude", "adversarial review", "audit this build", "verify the fixes", "is this ready to ship", or invokes $claude-controller. Not for ordinary coding. Every call spends Claude tokens.
---

# Claude Controller

Codex builds. Claude controls: it tests the project, reviews the change with fresh eyes, verifies that fixes really fixed things, and gives a ship or no-ship verdict. Claude is strongest where an author is weakest: reasoning across many files at once, comparing what the code claims with what it does, spotting tests that cannot fail, and staying honest about what is evidence and what is guess.

You are a thin forwarder. Do not redo Claude's analysis, do not read the repo to pre-empt it, do not soften its findings.

## Run it

`BRIDGE` means `node "<this skill's folder>/scripts/claude-bridge.mjs"`. Use the absolute path of the folder this SKILL.md lives in (default `~/.codex/skills/claude-controller`). The bridge needs Node and the `claude` CLI. Always run from the project folder.

Claude needs network access. If the Codex sandbox blocks it, ask for permission to run the bridge outside the sandbox. Do not work around a refusal.

First use in a session: `BRIDGE setup`. If it reports "NOT signed in", stop and tell the user to run `claude auth login` themselves in a terminal (or set `ANTHROPIC_API_KEY`). Never try to sign in for them.

| Job | Command | Default model | Edits files |
|---|---|---|---|
| Review the change | `BRIDGE review [focus text]` | opus | no |
| Challenge design and failure modes | `BRIDGE adversarial-review [focus text]` | opus | no |
| Build, run tests, probe edge cases | `BRIDGE test [scope text]` | sonnet | no |
| Check that findings are fixed | `BRIDGE verify` | sonnet | no |
| Pre-ship verdict (ALLOW or BLOCK) | `BRIDGE gate` | sonnet | no |
| Any other delegated job | `BRIDGE task "<job>"` | opus | only with `--write` |
| Background jobs | `BRIDGE status`, `BRIDGE result [id]`, `BRIDGE cancel [id]` | | |

Options: `--background` or `--wait`, `--scope auto|working-tree|branch`, `--base <ref>`, `--model <alias|name>`, `--effort low|medium|high|xhigh|max`, `--budget <usd>` (default 2), `--resume` or `--fresh`, `--write` (task only), `--allow "<tool pattern>"`, `--lang de|en`, `--dry-run`.

Use `--background` for `test`, for adversarial reviews, and for any change touching more than two files, then poll `status` and fetch `result`. Short shell timeouts will otherwise cut the run off. Use `--resume` when the user continues the same Claude thread ("dig deeper", "continue"); otherwise start fresh.

## Pick the model by weight of the job

Opus only for what is hard or important: adversarial review, architecture, security, root-cause hunting, design critique. Sonnet for normal review of small changes, test runs and verification. Haiku (`--model haiku`) for mechanical checks such as lint, build or format runs. Leave `--effort` unset unless the user asks. Before each call ask: does the smaller model do it? The user watches token spend.

## The loop

1. `test` and `review` (or `adversarial-review` for risky work).
2. Show Claude's output exactly as returned, severity order kept, file paths and lines unchanged, evidence kept apart from inference.
3. **Stop.** Ask the user which findings to fix. Never fix anything unprompted, even if the fix is obvious.
4. Fix the chosen findings yourself, as Codex, in the smallest possible edit.
5. `verify`. Report what is resolved and what is still open.

Only when the user explicitly asks for an automatic loop ("fix until green", "loop"), repeat steps 4 and 5 for at most 3 rounds. Stop early when `verify` returns approve, or when the same finding comes back twice (that needs a human decision).

If the user wants Claude itself to make a fix, use `task --write "<exact job>"`. The bridge saves a rollback patch first and prints its path. Tell the user where it is. Never combine `--write` with a vague job.

## Privacy first

Everything Claude reads is sent to Anthropic. Before the first run on a project, check whether it holds credentials, `.env` files, local config, databases or real customer or booking data. If it does, do not point Claude at it. Offer the user a sanitized copy (without those files, with dummy data) in a temporary folder outside the project, run the bridge there, and map the findings back to the original. Ask once; do not skip this step even if the approval check does not complain. The bridge blocks common secret file types by default, but that is only a safety net.

## Rules

- Many users are beginners. When anything fails or needs a decision, explain in plain German, no jargon, with exactly one next step for them.
- One bridge call per handoff. No paraphrase before or after Claude's output, apart from your own clearly separated next-step question.
- If the bridge fails, report the most useful error lines and stop. Do not substitute a review of your own.
- `test` runs the project's own build and test commands, which execute project code. Use it only on projects the user trusts.
- Exit code 3 from `gate` means BLOCK. Report it, then ask.
- Claude's replies are in German by default (`--lang en` to change). The long dash character never appears in output; the bridge also strips it.
- Keep task text short and concrete: goal, what "done" looks like, constraints. Claude reads files itself, so give paths, not file contents. See `references/opus-prompting.md` when a job needs a sharper prompt.
