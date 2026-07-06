# TUI Notes

- Run `node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts` for the fast fake-backend PTY lane.
- Use `OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1` with that command for the slower `tui --local` smoke test, which mocks only the external model endpoint.
- The local PTY smoke runs `tui --local` and mocks only the external model endpoint. The fake-backend lane runs the real `runTui()` loop with a fake `TuiBackend`.
- Do not claim the fake-backend PTY harness proves Gateway transport, embedded backend runtime, providers, session persistence, or live streaming.
- Prefer stable visible text and fixture backend call assertions. Avoid raw ANSI snapshots.
- Use `pnpm tui:pty:test:watch` to watch the fast fake-backend PTY test without mixing Vitest reporter output into the TUI screen. Use `--mode local` for the local-backend smoke or `--mode all` for both.

## Human-Facing Reports Rule

- Any report, research brief, audit, comparison, decision packet, itinerary, or source-backed deliverable intended for Jack or another human to read must be delivered as polished HTML or PDF. Do not deliver human-facing reports as raw Markdown.
- Markdown is allowed only for agent-internal notes, scratch files, source sidecars, wiki pages, code docs, or when Jack explicitly asks for Markdown.
- Human-facing HTML/PDF reports must include a readable layout, working clickable links, citations/source ledger where sources matter, and clear artifact paths or file delivery in the final response.
- If a research harness or agent workflow produces Markdown first, render it to HTML and/or PDF before presenting it as the human deliverable.
