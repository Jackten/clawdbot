# Gateway Server Methods Notes

- agent session transcripts are a `parentId` chain/DAG; never append raw `type: "message"` entries via JSONL writes (missing `parentId` can sever the leaf path and break compaction/history). Always write transcript messages via `SessionManager.appendMessage(...)` (or a wrapper that uses it).

## Human-Facing Reports Rule

- Any report, research brief, audit, comparison, decision packet, itinerary, or source-backed deliverable intended for Jack or another human to read must be delivered as polished HTML or PDF. Do not deliver human-facing reports as raw Markdown.
- Markdown is allowed only for agent-internal notes, scratch files, source sidecars, wiki pages, code docs, or when Jack explicitly asks for Markdown.
- Human-facing HTML/PDF reports must include a readable layout, working clickable links, citations/source ledger where sources matter, and clear artifact paths or file delivery in the final response.
- If a research harness or agent workflow produces Markdown first, render it to HTML and/or PDF before presenting it as the human deliverable.
