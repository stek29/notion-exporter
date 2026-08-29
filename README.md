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
  --root 59833787-2cf9-4fdf-8782-e53db20768a5 \
  --root https://www.notion.so/example-248104cd477e80fdb757e945d38000bd \
  --skip 33333333-3333-3333-3333-333333333333 \
  --output /work/export \
  --cache /cache
```

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
  -v "$PWD/cache:/cache" \
  notion-backup export \
  --root ... \
  --output /work/export \
  --cache /cache
```

The image is one-shot, runs as a non-root user by default, and contains no scheduler or restic installation.

## Restic boundary

```bash
rm -rf /work/export
mkdir -p /work/export

notion-backup export --root ... --output /work/export --cache /cache
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
```

All canonical resource filenames use normalized Notion UUIDs. Resource JSON is deterministically serialized. Volatile Notion-hosted signed URLs are replaced by stable `backup_asset` references.

## Scope and limits

- Roots may be pages, databases or data sources.
- `--skip` accepts repeatable IDs or URLs. A skipped object is omitted and traversal through that edge is cut; independently reachable resources remain in scope.
- Views are exported only with their owning retained database. To exclude a database even when reachable elsewhere, skip its database ID explicitly.
- Relations are preserved as UUID references but do not implicitly expand backup scope.
- Page properties that are complete in the Page response are persisted directly; the dedicated property endpoint is reserved for potentially truncated values and rollups.
- Comments are skipped by default. Pass `--comments all` for an exhaustive, slower per-page and per-block comment scan.
- External URLs are not mirrored.
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
