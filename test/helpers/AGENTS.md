# Shared Test Helper Boundary

This directory holds shared test helpers reused by core and bundled plugin
tests.

## Bundled Plugin Imports

- Shared helpers in this tree must not hardcode repo-relative imports into
  `extensions/**`.
- When a helper needs a bundled plugin public surface, go through
  `src/test-utils/bundled-plugin-public-surface.ts`.
- Prefer `loadBundledPluginApiSync(...)`,
  `loadBundledPluginRuntimeApiSync(...)`,
  `loadBundledPluginContractApiSync(...)`, and
  `loadBundledPluginTestApiSync(...)` for eager access to exported surfaces.
- Prefer `resolveRelativeBundledPluginPublicModuleId(...)` or
  `resolveBundledPluginPublicModulePath(...)` when a helper needs a module id
  or filesystem path for dynamic import, mocking, or loading a plugin entrypoint
  such as `index.js`.
- If `vi.hoisted(...)` is involved, do not call imported helper functions from
  inside the hoisted callback. Resolve the module id outside the callback or
  switch to `vi.doMock(...)`.
- Do not keep plugin-local deep mocks or private `src/**` knowledge in shared
  helpers. Move those helpers into the owning bundled plugin package instead.

## Intent

- Keep shared helpers aligned with the same public/plugin boundary that
  production code uses.
- Avoid shared helper debt that makes core test lanes depend on bundled plugin
  private layout.

## Human-Facing Reports Rule

- Any report, research brief, audit, comparison, decision packet, itinerary, or source-backed deliverable intended for Jack or another human to read must be delivered as polished HTML or PDF. Do not deliver human-facing reports as raw Markdown.
- Markdown is allowed only for agent-internal notes, scratch files, source sidecars, wiki pages, code docs, or when Jack explicitly asks for Markdown.
- Human-facing HTML/PDF reports must include a readable layout, working clickable links, citations/source ledger where sources matter, and clear artifact paths or file delivery in the final response.
- If a research harness or agent workflow produces Markdown first, render it to HTML and/or PDF before presenting it as the human deliverable.
