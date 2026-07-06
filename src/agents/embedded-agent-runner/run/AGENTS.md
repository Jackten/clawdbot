<!-- Embedded runner test performance notes for limiting full-runner coverage to integration behavior. -->

# Embedded Runner Test Performance

The embedded attempt runner is one of the most expensive agent test surfaces.
Use full-runner tests only when the behavior truly requires the runner.

## Guardrails

- Prefer focused helper tests for prompt assembly, runtime-context construction,
  cache metadata, token accounting, and maintenance decision logic.
- Keep full `runEmbeddedAttempt` coverage for cross-component behavior that
  cannot be proven through helpers, not for a single derived field.
- When extracting a helper from runner logic, make production call that helper
  directly, then test the helper. Avoid test-only copies of runner behavior.
- Preserve context-engine coverage for `sessionKey`, `sessionFile`, token
  budget, current token count, prompt cache, and routing fields when slimming
  tests.
- Treat a standalone full-runner test above a few seconds as suspect. First ask
  whether the proof can move to a production helper plus one cheap integration
  smoke.

## Verification

- For runner test slimming, run the touched helper test and the nearest
  two-file runner/context-engine surface.
- Record Vitest duration, wall time, and RSS when the change is performance
  motivated.

## Human-Facing Reports Rule

- Any report, research brief, audit, comparison, decision packet, itinerary, or source-backed deliverable intended for Jack or another human to read must be delivered as polished HTML or PDF. Do not deliver human-facing reports as raw Markdown.
- Markdown is allowed only for agent-internal notes, scratch files, source sidecars, wiki pages, code docs, or when Jack explicitly asks for Markdown.
- Human-facing HTML/PDF reports must include a readable layout, working clickable links, citations/source ledger where sources matter, and clear artifact paths or file delivery in the final response.
- If a research harness or agent workflow produces Markdown first, render it to HTML and/or PDF before presenting it as the human deliverable.
