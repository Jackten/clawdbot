# Outbound Test Performance

Outbound helpers sit on hot reply, action, media, and channel contract paths.
Keep argument and payload tests narrow unless they are intentionally exercising
real delivery.

## Guardrails

- Prefer pure param/spec/normalization helpers for send-argument, media-source,
  alias, and payload-shape coverage. Do not import real delivery runtimes when
  the test only asserts normalized arguments.
- Avoid partial-real mocks with `importActual()` around broad outbound delivery
  modules. Mock the exact seam under test, then cover the real delivery runtime
  in a focused integration test.
- Before discovering plugin-owned media/action metadata, first check whether the
  call actually includes plugin-owned params. Standard send params should not
  trigger bundled channel message-tool discovery.

## Verification

- Benchmark the affected outbound test file before/after with
  `pnpm test <file>`.
- Run the closest media/action/payload contract test when changing a shared
  outbound helper.

## Human-Facing Reports Rule

- Any report, research brief, audit, comparison, decision packet, itinerary, or source-backed deliverable intended for Jack or another human to read must be delivered as polished HTML or PDF. Do not deliver human-facing reports as raw Markdown.
- Markdown is allowed only for agent-internal notes, scratch files, source sidecars, wiki pages, code docs, or when Jack explicitly asks for Markdown.
- Human-facing HTML/PDF reports must include a readable layout, working clickable links, citations/source ledger where sources matter, and clear artifact paths or file delivery in the final response.
- If a research harness or agent workflow produces Markdown first, render it to HTML and/or PDF before presenting it as the human deliverable.
