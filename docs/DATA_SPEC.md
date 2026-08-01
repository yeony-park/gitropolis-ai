# Gitropolis Data Specification

> Status: Early public contract
> Last updated: 2026-07-30
> GitHub REST API version: `2026-03-10`

This document contains data behavior that has been implemented or verified well
enough to be part of Gitropolis's public contract. Experimental queries,
candidate metrics, sample responses, and unverified assumptions remain in local
development notes until they are validated.

## Data categories

Gitropolis distinguishes between three kinds of data:

- **Raw data** comes directly from GitHub REST API responses or another named
  source.
- **Derived data** is calculated deterministically from raw data and historical
  snapshots.
- **Generated data** is produced by classification, clustering, or summarization
  and must not be represented as a raw GitHub value.

Every stored snapshot must identify its schema version, collection time, source,
and whether collection coverage was complete.

## Repository identity

Gitropolis uses the numeric GitHub repository `id` as the stable repository
identifier. `node_id` is retained for GraphQL interoperability.

The repository `full_name` is mutable. A rename or transfer must update the
displayed name without creating a second building for the same repository ID.

## Verified GitHub repository fields

The following fields are available from the public repository API and have been
verified against a public repository:

| GitHub field | Stored meaning |
|---|---|
| `id` | Stable REST repository identifier |
| `node_id` | GraphQL node identifier |
| `full_name` | Current `owner/name` |
| `html_url` | Public repository URL |
| `description` | Repository description, when present |
| `created_at` | Repository creation time |
| `updated_at` | GitHub metadata update time |
| `pushed_at` | Most recent push time, when present |
| `stargazers_count` | Current star count |
| `forks_count` | Current fork count |
| `subscribers_count` | Actual GitHub watcher count |
| `open_issues_count` | Combined number of open issues and pull requests |
| `language` | Primary detected language, when present |
| `topics` | Repository topics |
| `default_branch` | Current default branch |
| `archived` | Whether the repository is archived |
| `visibility` | Repository visibility |
| `license.spdx_id` | SPDX license identifier, when present |

`watchers_count` is not stored because GitHub exposes it as another name for the
star count. Gitropolis uses `subscribers_count` when it needs the actual watcher
count.

## Languages and README metadata

The repository languages endpoint returns detected byte counts keyed by
language. Gitropolis may derive a language share by dividing each language's
byte count by the total detected byte count.

For README data, Gitropolis retains metadata needed for change detection,
including the file path, size, and SHA. README content is processed only as
needed for classification or summarization and is not copied into public
outputs.

## Implemented collector scope

The `collect` command currently accepts one or more explicit
`OWNER/REPOSITORY` arguments. For each repository, it requests:

- repository details;
- detected language byte counts;
- README metadata;
- commits on the default branch from the previous 30 days;
- contributor count metadata.

Requests are made sequentially. After repository collection finishes, the CLI
requests the current rate-limit state so that the stored and displayed
remaining count reflects the completed collection.

If a repository-detail request fails, collection continues with the remaining
repositories. Successfully collected repositories are retained in the
snapshot, the failed repository endpoint is added to
`source.coverage_errors`, and the CLI reports successful and failed repository
counts.

The commit and contributor counts use the final page number from GitHub's
pagination links as a count. If the response has no pagination link, the number
of returned records is used.

## `snapshot-v1`

Each generated snapshot contains:

- `schema_version` and `collected_at`;
- `source.github_api_version`;
- `source.authenticated`;
- `source.coverage_complete`;
- available `core`, `search`, and `graphql` rate-limit resources;
- `source.coverage_errors`;
- the collected repository records.

Repository records contain the verified identity and repository fields listed
above, language byte counts and shares, README metadata, 30-day commit count,
and contributor count. The following history-dependent fields are present but
remain `null` until sufficient snapshots exist:

- `delta_stars_1d`;
- `delta_stars_7d`;
- `delta_stars_30d`;
- `star_velocity_7d`;
- `star_acceleration`.

## Historical values

Star growth, velocity, acceleration, and other trend values require historical
snapshots. When the required history does not exist, the value must be `null`.

- `0` means the metric was measured and no change occurred.
- `null` means the metric could not be calculated.

An API failure must never be stored as a numeric zero.

## Error and coverage rules

- Missing optional GitHub fields are stored as `null`.
- Rate-limit responses follow the server-provided retry or reset time.
- Partial endpoint failures are recorded as incomplete coverage.
- A repository-detail failure does not discard successful repository records
  or prevent later repositories from being attempted.
- A `404` may indicate a rename, transfer, deletion, or visibility change and
  must not immediately create a permanent deletion event.
- A changed `full_name` with the same repository `id` is treated as a rename or
  transfer.

## Authentication and secrets

The local CLI may read a GitHub token from the `GITHUB_TOKEN` environment
variable. It also supports a limited anonymous mode for public data.

Authenticated collection has been verified with a fine-grained personal access
token limited to read-only public repository access, with no account or write
permissions. The verification reported a core limit of 5,000 requests per hour,
compared with 60 requests per hour for anonymous collection.

Tokens and authorization headers must never be written to:

- the repository;
- source code or fixtures;
- logs or exception messages;
- issues or pull requests;
- generated snapshots or reports.

Automated tests cover anonymous headers, authenticated headers, API-error
redaction, CLI-error redaction, and snapshot output. A live authenticated
collection also verified that the generated snapshot did not contain the token.

Gitropolis collects repository-level public aggregates and avoids retaining
unnecessary personal data. It does not store stargazer lists, contributor email
addresses, or commit-author personal information.

## Promotion rule

New fields, endpoints, and derived metrics are first documented and evaluated in
local development notes. They are added to this public specification only after
their implementation and behavior have been verified.
