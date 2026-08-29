# notion-backup

`notion-backup` creates complete, deterministic filesystem snapshots of configured Notion roots using only the official Notion API and `@notionhq/client`.

Every export starts with an empty directory, recursively traverses all reachable pages, blocks, databases, data sources and views, downloads Notion-hosted assets, and runs an offline verifier before succeeding. Historical snapshots, deduplication, retention and remote storage belong to tools such as restic.

## Status

The snapshot format is versioned but the project is initially released as `0.1.0`. Test restores and verification before relying on it as the only copy of important data.

## Here be dragons

This is AI-assisted, vibe-coded backup software. It works for me and my Notion
workspace; it might not work for you or yours. There is no warranty, expressed
or implied, and a green verification result is not a substitute for testing an
actual restore. Keep another copy of anything important, inspect the output, and
do not make this tool the only thing standing between you and data loss.

## Requirements

- Node.js 24 or the OCI image
- A Notion token with read-content and user-information capabilities
- Read-comments capability only when using `--comments all`
- Each configured root shared with the integration

Notion does not expose exhaustive workspace enumeration through its public API. Roots are authoritative; search is not used for backup correctness.

## Installation

```bash
npm ci
npm run build
node dist/cli.js --help
```

## Export

The output directory must exist and be empty, or be absent so the exporter can create it.

```bash
export NOTION_TOKEN_FILE=/run/secrets/notion_token

notion-backup export \
  --root 11111111-1111-1111-1111-111111111111 \
  --root https://www.notion.so/example-22222222222222222222222222222222 \
  --skip 33333333-3333-3333-3333-333333333333 \
  --output /work/export
```

Roots and skips can instead be kept in a JSON file:

```json
{
  "roots": [
    "11111111-1111-1111-1111-111111111111",
    "https://www.notion.so/example-22222222222222222222222222222222"
  ],
  "skips": ["33333333-3333-3333-3333-333333333333"]
}
```

```bash
notion-backup export --config export.json --output /work/export
```

`--root` and `--skip` may still be supplied with `--config`; their values are added to the file's lists.

The token may instead be provided through `NOTION_TOKEN`. Supplying both secret sources is an error. Tokens, authorization headers and signed asset URLs are never intentionally logged.

Rate controls are independently configurable:

```bash
notion-backup export \
  --root ... \
  --output /work/export \
  --concurrency 3 \
  --requests-per-second 2.5 \
  --asset-concurrency 4
```

Only one exporter should use a given Notion integration token at a time because Notion rate limits apply per connection.

## Incremental export

Pass a previous complete snapshot to reuse unchanged resource JSON and downloaded assets while still producing a standalone snapshot in a new empty output directory:

```bash
notion-backup export \
  --config export.json \
  --incremental-from /backups/previous \
  --output /backups/current
```

The previous snapshot is verified before any output is written. Incremental mode checks each nested page independently, compares current top-level block membership, probes previously linked child pages and databases, and fully enumerates every data source to reconcile row membership. Missing, moved, trashed or uncertain resources force a fresh crawl rather than reuse. A moved resource remains in the new snapshot only when it is reachable through another current root or parent.

Resource reuse requires matching edit timestamps and structural fields. If timestamps are absent, comments are enabled, or the skip list changed, the affected resources are exported normally. Assets are reused directly from the previous snapshot through its internal hashed asset index; there is no separate external asset cache.

## Verify

Verification is fully offline and requires no Notion token:

```bash
notion-backup verify /work/export
```

The verifier checks snapshot structure, all JSON files, manifest counts, canonical IDs, row and database associations, comment references, and every content-addressed asset hash.

## Container

```bash
docker build -t notion-backup .

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e NOTION_TOKEN_FILE=/run/secrets/notion_token \
  -v "$PWD/notion-token:/run/secrets/notion_token:ro" \
  -v "$PWD/export:/work/export" \
  notion-backup export \
  --root ... \
  --output /work/export
```

The image is one-shot, runs as a non-root user by default, and contains no scheduler or restic installation.

## Restic boundary

```bash
rm -rf /work/export
mkdir -p /work/export

notion-backup export --root ... --output /work/export
restic backup /work/export --tag notion

rm -rf /work/export
```

A failed export is nonzero and leaves partial output for diagnosis. The next orchestration run is responsible for cleaning it.

## Snapshot layout

```text
manifest.json
roots.json
users.json
pages/<page-id>/{page,blocks,comments}.json
pages/<page-id>/properties/<property-id>.json
comments/<comment-id>.json
databases/<database-id>/database.json
databases/<database-id>/views/<view-id>.json
data-sources/<data-source-id>/{data-source,rows}.json
assets/sha256/<prefix>/<sha256>
assets/metadata/<prefix>/<sha256>.json
assets/index.json
```

All canonical resource filenames use normalized Notion UUIDs. Resource JSON is deterministically serialized. The manifest intentionally contains no export timestamp. Volatile `request_id` fields are discarded, and hosted files plus user avatars are replaced by stable `backup_asset` references.

## Scope and limits

- Roots may be pages, databases or data sources.
- `--skip` accepts repeatable IDs or URLs. A skipped object is omitted and traversal through that edge is cut; independently reachable resources remain in scope.
- Views are exported only with their owning retained database. To exclude a database even when reachable elsewhere, skip its database ID explicitly.
- Relations are preserved as UUID references but do not implicitly expand backup scope.
- Page properties that are complete in the Page response are persisted directly; the dedicated property endpoint is reserved for potentially truncated values and rollups.
- Incremental exports always reconcile current reachability into a new empty snapshot; the previous snapshot is never modified in place.
- Comments are skipped by default. Pass `--comments all` for an exhaustive, slower per-page and per-block comment scan.
- External content URLs are not mirrored, except user avatars.
- Notion search is not used as authoritative enumeration.
- The SDK's full data-source iterator partitions query windows beyond Notion's normal 10,000-result boundary. An unpartitionable boundary fails the export.
- The tool does not implement incremental sync, restoration, Markdown export, scheduling, retention or restic invocation.

## Development

```bash
npm run check
npm run build
```

Most tests use a mocked `NotionApi`; CI does not require a live workspace or secrets.

## License

BSD Zero Clause License (`0BSD`).
