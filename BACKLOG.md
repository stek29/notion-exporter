# Backlog

## PAT-compatible user snapshots

The exporter currently expects an integration token that can call Notion's
`List all users` endpoint. Personal access tokens cannot call that endpoint.

Add a capability-aware fallback that:

- retrieves the authenticated identity through `users.me`;
- attempts `List all users` when the token supports it;
- falls back to the authenticated user plus user objects referenced by exported
  pages, properties, blocks, comments, databases, data sources and views;
- retrieves fuller representations of referenced users where the API permits;
- preserves the existing strict failure behavior for unrelated authorization,
  transport and malformed-response errors;
- includes mocked tests for both integration-token and PAT behavior.

Neither `bot_id`, `workspace_id` nor `workspace_name` should be required as
export configuration. They are credential-management metadata, not inputs to
root traversal.

## Poll-based incremental exports

Add an incremental mode that uses a previous verified snapshot and persistent
state to avoid refetching unchanged resources while still producing a complete,
standalone, offline-verifiable snapshot in a new empty output directory.

- Track every known page and resource independently by ID, type,
  `last_edited_time`, parent, membership and content hash.
- Do not treat a root or ancestor page's `last_edited_time` as a recursive
  subtree watermark. Nested pages must be checked independently.
- Recrawl the blocks of changed pages to discover added, removed or moved child
  pages and databases.
- Use overlapping `last_edited_time` filters for changed data-source rows, plus
  explicit membership reconciliation so deletions and moves are not missed.
- Reuse unchanged JSON and assets from the verified base through safe copies or
  hard links, then run the normal complete snapshot verifier.
- Keep comments disabled by default and do not add webhook infrastructure.
- Preserve the existing empty-output, deterministic-output and strict-failure
  guarantees.
