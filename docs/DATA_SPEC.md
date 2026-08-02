# Gitropolis Data Specification

> Status: Early public contract
> Last updated: 2026-08-03
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

## GH Archive candidate discovery

The `discover` command accepts a UTC hour through `--from` and processes between
one and 24 consecutive hourly GH Archive files. Each gzip file is streamed and
parsed line by line rather than loaded into memory. Hourly files are requested
sequentially with a default one-second interval and a 60-second timeout per
file.

Discovery does not use repository names, topics, README text, or other keywords.
It counts valid `WatchEvent` records by case-insensitive repository name and
retains the first and last event timestamps observed in the requested window.
Candidates are ranked by descending event count, then by repository name for a
deterministic tie break. The default top 10 candidates are enriched by the
existing GitHub REST collector.

An hourly request failure does not discard events collected from other hours.
Malformed JSON records are skipped individually, recorded as coverage errors,
and do not prevent the rest of their hourly file from being processed. A
candidate is retained even when its GitHub enrichment fails.

An end-to-end verification processed all 24 hourly files for 2026-07-30 and
enriched the selected repositories. The source contained 22 malformed JSON
lines, so the output correctly reported incomplete record coverage even though
all 24 files were processed. The experiment produced ranked repository
candidates without keyword filters. AI relevance was not evaluated, and the
result does not yet establish complete star-count accuracy.

## `candidate-v1`

Each candidate snapshot contains:

- a UTC `window.from` and exclusive `window.to`;
- `source.type` set to `gh-archive`;
- requested and successfully processed hour counts;
- total valid WatchEvents and distinct repositories observed;
- GitHub authentication and rate-limit metadata when enrichment runs;
- archive, parsing, and GitHub enrichment coverage errors;
- repositories with `full_name`, `watch_events`, `first_seen_at`, and
  `last_seen_at`;
- a nested `github` repository snapshot when enrichment succeeds, otherwise
  `null`.

## Seven-day activity backfill

The `backfill` command accepts a UTC midnight through `--from` and processes
between one and seven complete UTC days. It requests all 24 hourly GH Archive
files for each day and writes `activity-series-v1` without applying a top-N
repository cutoff. Daily progress includes processed hours and observed
`WatchEvent` counts.

Raw activity collection and current GitHub metadata enrichment are separate
steps. `enrich-activity` reads an existing activity series and supports either
a minimum count in any single UTC day or a minimum total across the complete
window. The default Main Radar screening floor is five events in one UTC day.
An Emerging Scout pass can separately use a three-event window total. These are
enrichment filters, not breakout or momentum scores.

The `screening` metadata profile requests repository details only, including
stars, forks, topics, and description. The `classification` profile also
records README metadata and SHA. The `full` profile additionally records
language distribution, 30-day commit count, and contributor count.
Repositories below the floor remain in the activity series with
`metadata_selected=false` and `current=null`. A failed GitHub request does not
remove the repository's GH Archive history. Re-running enrichment on a partial
snapshot with the same profile reuses successful repository metadata and
requests only missing selected repositories.

### `activity-series-v1`

Each activity-series snapshot contains:

- the UTC `window.from`, exclusive `window.to`, and number of days;
- archive and metadata coverage reported separately;
- requested and collected hour counts, observed WatchEvents, and distinct
  repositories;
- per-day hour coverage and WatchEvent totals;
- every observed repository's window total, first and last observation time,
  and daily counts;
- `observed_watch_velocity_per_day` only when archive coverage is complete,
  otherwise `null`;
- metadata-selection method, threshold, profile, selected count, collected
  count, and collection time after enrichment;
- archive and GitHub coverage errors with their source identified.

An end-to-end run requested 168 hours from 2026-07-27 through 2026-08-02. At
the time of the run, the last eight UTC hours of 2026-08-02 had not yet been
published by GH Archive, so 160 hours were available. The partial snapshot
retained 7,000 valid WatchEvents across 5,274 repositories and correctly left
velocity values as `null`. The then-current daily floor of three selected 104 repositories;
current GitHub metadata was collected for 100, with failures retained as
coverage errors. These sample counts demonstrate behavior, not a stable product
benchmark.

## AI relevance and keyword observation

The `analyze` command reads an existing `candidate-v1` or enriched
`activity-series-v1` snapshot. It reuses the
collected repository description and topics and requests README content only
when README metadata is present. By default, at most the first 12,000 README
characters are processed. Raw README content is never written to the analysis
output.

The initial `ai-relevance-rules-v1` methodology is deterministic and
explainable. It normalizes aliases and hyphenation, observes GitHub topics, and
extracts AI-oriented terms and compounds from descriptions and README text.
The keyword list is not a discovery filter: terms such as `graph-rag` and
`agentic-rag` can be observed after a repository has already entered the GH
Archive candidate set.

Analysis records a keyword census across every input repository, including
repositories that the current classifier labels `not-ai`. The census reports
the number of analyzed repositories, repositories with observations, source
observation records, unique keywords, classifier-evidence keywords, and each
keyword's repository count, occurrence count, and sources. This prevents the
provisional rule classifier from silently discarding possible emerging terms.

The classifier boundary is provider-neutral and identifies the classifier kind
and methodology version in the output. The rule implementation is the current
default; a live model provider, model, budget, and data policy have not yet been
selected.

Each keyword observation contains:

- `observed_at`;
- the stable numeric `repository_id`;
- normalized `keyword_id`;
- `source` as `topics`, `description`, or `readme`;
- `occurrence_count` within that source;
- source confidence of `0.95`, `0.80`, or `0.65`, respectively.

AI relevance evidence contributes `0.65` from a topic, `0.45` from a
description, or `0.30` from README text, with per-source caps of `0.80`, `0.60`,
and `0.45`. A total score of at least `0.50` is `ai-related`, a score from
`0.25` up to but excluding `0.50` is `review`, and a lower score is `not-ai`.
These are provisional MVP rules, not a measured precision claim.

An AI-related repository is placed in the `unknown` pool unless a non-broad
keyword is observed in at least five distinct AI-related repositories in the
same snapshot. Repositories sharing such a keyword are marked provisional
`emerging`. This does not promote a community to `active` or replace the later
multi-week lifecycle criteria.

A missing GitHub enrichment produces an `unavailable` assessment while
preserving the candidate. A README request failure preserves classification
from available descriptions and topics, marks analysis coverage incomplete, and
adds the failure to `source.coverage_errors`. A rate limit stops later README
requests without stopping description and topic analysis.

### `topic-analysis-v1`

Each topic analysis snapshot contains:

- the observation timestamp and original candidate window;
- the candidate and methodology schema versions;
- GitHub authentication, original candidate coverage and errors, and combined
  analysis coverage metadata;
- repository identity, AI relevance score, decision, and evidence;
- provisional `unknown` or `emerging` status for AI-related repositories;
- time-stamped `KeywordObservation` records;
- an all-repository keyword census and classifier kind.

An authenticated end-to-end check analyzed the three leading repositories from
the 2026-07-30 GH Archive experiment with complete README coverage. Two were
classified `ai-related`, while one remained in `review`; no repeated specific
keyword existed in the three-repository sample, so no repository was marked
`emerging`. The analysis step had no coverage errors, while combined coverage
remained incomplete because the input candidate snapshot contained malformed GH
Archive records. Network-free tests separately verify `graph-rag` repeated
across five repositories and a single-repository `agentic-rag` observation.
This check establishes technical feasibility only and is not a representative
accuracy benchmark.

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
- Rate-limit responses use `Retry-After` when available and otherwise use
  `X-RateLimit-Reset`.
- A `403` is treated as rate-limited only when `Retry-After` is present,
  `X-RateLimit-Remaining` is zero, or the response explicitly identifies a
  rate or abuse limit. `X-RateLimit-Reset` alone is not sufficient because
  ordinary repository-access failures also include it.
- Short rate-limit delays are retried at most twice. Delays longer than 60
  seconds are not awaited automatically.
- An exhausted or long rate limit stops further repository requests while
  preserving repository records collected before the limit.
- Partial endpoint failures are recorded as incomplete coverage.
- Missing or malformed GH Archive records are never counted as valid events and
  are exposed through candidate coverage errors.
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
