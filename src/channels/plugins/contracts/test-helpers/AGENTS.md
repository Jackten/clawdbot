# Channel Contract Helper Boundary

This directory holds core-owned channel contract test helpers.

This file adds channel-specific rules on top of `src/channels/AGENTS.md`.

## Bundled Plugin Imports

- Core contract helpers in this directory must not hardcode repo-relative
  imports into `extensions/**`.
- When a helper needs a bundled plugin public/test surface, go through
  `src/test-utils/bundled-plugin-public-surface.ts`.
- Prefer `loadBundledPluginTestApiSync(...)` for eager access to exported test
  helpers.
- Prefer `resolveRelativeBundledPluginPublicModuleId(...)` when a test needs a
  module id for dynamic import or mocking.
- If `vi.mock(...)` hoisting would evaluate the module id too early, use
  `vi.doMock(...)` with the resolved module id instead of falling back to a
  hardcoded path.
- For contract helpers, prefer minimal in-memory channel/plugin fixtures when
  the contract only needs capabilities, session binding hooks, routing metadata,
  or outbound payload helpers. Do not load broad `api.ts`, `runtime-api.ts`, or
  `test-api.ts` barrels for incidental setup.
- If a bundled plugin parser is the contract under test, load the narrow module
  that owns that parser or promote a small public artifact. Avoid pulling a full
  extension barrel just to parse a target id.

## Intent

- Keep core contract helpers aligned with the same public/plugin boundary that
  production code uses.
- Avoid drift where core contract helpers start reaching into bundled plugin
  private files by path because it is convenient in one test.

## Human-Facing Reports Rule

- Any report, research brief, audit, comparison, decision packet, itinerary, or source-backed deliverable intended for Jack or another human to read must be delivered as polished HTML or PDF. Do not deliver human-facing reports as raw Markdown.
- Markdown is allowed only for agent-internal notes, scratch files, source sidecars, wiki pages, code docs, or when Jack explicitly asks for Markdown.
- Human-facing HTML/PDF reports must include a readable layout, working clickable links, citations/source ledger where sources matter, and clear artifact paths or file delivery in the final response.
- If a research harness or agent workflow produces Markdown first, render it to HTML and/or PDF before presenting it as the human deliverable.
