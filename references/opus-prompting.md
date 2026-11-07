# Prompting Claude from Codex

Claude follows clear structure and reasons well when it knows why. The bridge already wraps `review`, `adversarial-review`, `test`, `verify` and `gate` in tested prompts. This page is for `task` and for sharpening a focus text.

## Shape of a good job

State, in this order: the goal, what done looks like, the constraints and the reason behind each, and the output you want. Short beats long. One job per run; split unrelated asks.

Use XML tags when the job is not trivial. Stable names help:

- `<task>` the concrete job and the failure or feature context
- `<grounding_rules>` every claim traceable to files read or command output; inferences marked
- `<output_contract>` exact sections, order and length
- `<verification_loop>` which checks to run before reporting
- `<action_safety>` for `--write`: narrow edits, no unrelated refactors, no secrets, no dependency changes
- `<scope_limits>` what Claude must not touch

## What works

- Positive instructions with a reason ("keep edits inside src/auth because the billing module is frozen") beat bare prohibitions.
- Give paths and symptoms, not pasted file contents. Claude reads the repo itself, and that saves tokens.
- Ask for evidence: "quote the failing line", "name file and line".
- Ask for a verdict first, details second.
- Raise `--effort` only after the prompt is tight.

## What to avoid

- "Make it better" or "check everything" with no scope or definition of done.
- Review and fix in one run. Review first, decide, then fix.
- Style, naming and cleanup requests in a controller run. They bury real findings.
- Capital-letter shouting and stacked "never" lines. One clear rule with a reason is enough.
- Letting Claude run unattended with `--write` on a dirty tree without a stated scope.

## Strengths worth aiming it at

Cross-module contracts and data flow. Auth, tenant isolation, retries and partial failure. Tests that pass for the wrong reason. Migrations and compatibility. Root-cause diagnosis from a symptom. Design critique of a UI against its stated purpose. Plain-language explanation of why something is risky.
