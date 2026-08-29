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
