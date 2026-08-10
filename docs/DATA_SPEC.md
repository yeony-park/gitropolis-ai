# Gitropolis Data Specification

> Status: Early public contract
> Last updated: 2026-08-10
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
It validates each `WatchEvent` event ID as a positive decimal string, removes
repeated IDs across the full discovery window, and counts the remaining valid
records by case-insensitive repository name. Event IDs stay as strings during
validation and are not converted to JavaScript numbers. Discovery retains the
first and last event timestamps observed in the requested window.
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
- additive event-integrity counters when the snapshot was created by a
  deduplication-aware collector;
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
- source-level and per-day event-integrity counters in newly generated
  snapshots;
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
velocity values as `null`. The then-current daily floor of three selected 104
repositories; current GitHub metadata was collected for 100, with failures
retained as coverage errors. These sample counts demonstrate behavior, not a
stable product benchmark.

## GH Archive event integrity

New `candidate-v1` and `activity-series-v1` outputs include an additive
`event_integrity` object. Older v1 snapshots without this object remain valid
inputs. The object contains:

| Field | Meaning |
|---|---|
| `deduplication_applied` | Whether stable event-ID deduplication was applied |
| `raw_watch_events_seen` | All JSON `WatchEvent` records encountered before identity and semantic rejection |
| `unique_watch_events` | Valid events accepted after deduplication |
| `duplicate_event_ids` | Records skipped because an accepted event ID was already seen in the command window |
| `missing_event_ids` | `WatchEvent` records without an ID |
| `invalid_event_ids` | IDs that are not positive decimal strings |
| `invalid_watch_events` | All `WatchEvent` records rejected by identity or semantic validation |
| `recovered_records` | JSON objects reconstructed from bounded physical lines split by literal newlines inside strings |
| `malformed_records` | Logical archive records that remain unparseable after bounded recovery |

`recovered_records` is additive. Older event-integrity objects without the
field remain valid inputs and are interpreted as having no recorded recovery
count, not as proof that recovery was unnecessary.

Only an event that passes ID, action, repository-name, timestamp, and hourly
window validation is registered in the accepted-ID set. This allows a valid
record to be counted when an invalid record with the same ID appeared earlier.
Once an event is accepted, any later occurrence of that ID is classified as a
duplicate before other semantic checks, including when it appears in another
hourly file.

A duplicate does not make coverage incomplete because it is removed
deterministically. Missing or invalid IDs, malformed records, semantically
invalid WatchEvents, failed hourly files, and partial streams remain coverage
errors. A fully recovered record is counted in `recovered_records` and does not
make coverage incomplete. Recovery is limited to structurally incomplete JSON
objects whose string value remains open, with fixed line and byte bounds; the
parser does not join arbitrary malformed records. Accepted WatchEvent totals in
the source, daily buckets, repository records, and
`event_integrity.unique_watch_events` describe the same deduplicated population.

An integrity verification reran 2026-07-01 through 2026-07-07 and reproduced
the earlier 45,547 WatchEvents and 24,995 repositories exactly. It found zero
duplicate, missing, or invalid event IDs and 119 malformed archive lines.
A supporting 2026-06-24 through 2026-06-30 run likewise found 58,267 unique
WatchEvents, zero identity anomalies, and 227 malformed lines. These results
show that event-ID duplication did not explain the observed daily spikes in
those windows; they are experimental observations, not a guarantee for future
GH Archive files.

A 2026-08-01 through 2026-08-04 update collected 87 of the requested 96 hours
because the final nine August 4 UTC files were not yet published. The partial
snapshot retained 3,108 unique WatchEvents, zero identity anomalies, and 43
malformed lines without representing the four-day window as complete.

After bounded multi-line recovery was implemented, all 24 files for
2026-07-30 were reprocessed. The parser produced 3,963,407 logical records,
recovered 11 objects that had previously appeared as 22 malformed physical
lines, and left zero unrecoverable records. The recovered sample contained nine
`IssueCommentEvent` records and two `CreateEvent` records, not WatchEvents. This
sample verifies the recovery path but does not guarantee that every future
archive defect will be recoverable.

## Repository lifecycle

The `lifecycle` command reads one or more ordered, consecutive
`activity-series-v1` snapshots and writes `repository-lifecycle-v1`. Inputs may
use one-to-seven-day collection batches; the command combines their daily
observations and derives Monday 00:00 UTC through Monday 00:00 UTC weeks. A gap,
overlap, or out-of-order input is rejected instead of being silently repaired.

The default screening signals are independent:

- **Main Radar:** at least five observed WatchEvents in one UTC day;
- **Emerging Scout:** at least three observed WatchEvents in the ISO week;
- **Fast breakout:** at least ten observed WatchEvents in the ISO week.

These thresholds can be overridden for evaluation. Screening membership does
not itself define lifecycle state. The initial deterministic lifecycle is:

```text
candidate → active → cooling → inactive
```

- A first complete observed week at or above Scout enters `candidate`.
- Two consecutive observed Scout-qualified weeks promote a candidate to
  `active`.
- Three strictly increasing complete weeks may enter `active` when the third
  week first reaches Scout.
- A first confirmed week below Scout changes a candidate or active repository
  to `cooling`; a second consecutive confirmed week changes it to `inactive`.
- An inactive repository that reaches Scout again emits `revived` and returns
  to `candidate`.
- A new or revived fast breakout remains a candidate with
  `breakout_status=pending` until the next observable week. At least Scout
  activity confirms it; a confirmed below-Scout week marks it unconfirmed.

Coverage is represented at three levels. `complete` means all seven calendar
days, all 168 hourly files, and all records were processed. `record-warning`
means all hours are present but at least one record-level error remains;
observed positive threshold crossings are usable lower bounds, while negative
transitions are blocked. `temporal-incomplete` means a calendar day or hourly
file is absent and freezes lifecycle state. Partial leading and trailing ISO
weeks are retained as temporal-incomplete rather than padded with measured
zeros.

Legacy activity snapshots without `event_integrity` remain valid inputs. Each
input, week, and repository-week record exposes integrity verification as
`verified`, `partial`, or `unavailable`. The absence of a historical integrity
field is not converted into a false success or failure.

Each lifecycle repository contains all observed activity needed for its weekly
history, Main and Scout membership, current lifecycle state, consecutive-week
counters, breakout state, availability state, and stable GitHub repository ID
when metadata provided one. Availability is `available`, `unavailable`, or
`unknown` and is never inferred from WatchEvent absence. Input lineage stores
file names without local directory paths.

Lifecycle events contain the repository identity, event type, effective week,
previous state, next state, and a deterministic reason. Event types include
candidate detection, activation, cooling, inactivation, revival, breakout
detection and resolution, and data-incomplete protection. The output's
`generated_at` is derived from the exclusive end of the latest input day, so
the same ordered inputs and thresholds produce the same JSON values.

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

## Renderer-ready city data

The `build-city` command joins three already-created inputs:

- one enriched `activity-series-v1` snapshot;
- a `topic-analysis-v1` derived from that exact activity window;
- a `repository-lifecycle-v1` whose window covers the activity window.

The builder rejects a candidate-only analysis or mismatched windows rather than
joining unrelated observations. Repository joins use the stable numeric GitHub
repository ID whenever it is available. A case-insensitive `full_name` fallback
is used only for a side of the join that lacks a stable ID, so a renamed path or
reused repository name cannot silently replace a known identity.

The first city methodology is deliberately provisional. It includes only
repositories classified `ai-related` by the supplied analysis and for which
current GitHub metadata exists. A primary community is selected from observed
non-broad keywords using AI-related repository frequency, source confidence,
occurrence count, and a deterministic lexical tie break. Broad keyword rules
assign one of seven macro districts; unmatched AI repositories remain visible
in `frontier`. These rules organize the MVP renderer and do not claim to be a
verified ontology or final Topic Momentum model.

### `city-v1`

Each city snapshot contains:

- a deterministic generation time derived from source timestamps;
- the activity window and input methodology versions;
- separate raw GH Archive, GitHub metadata, activity, analysis, and lifecycle
  coverage plus combined coverage;
- all eight district definitions, including `frontier`;
- observed communities with provisional `unknown` or `emerging` status;
- every eligible repository without a top-N storage cutoff;
- the current GitHub description as collected with repository metadata, or
  `null` when GitHub provides none;
- a deterministic `Why Gitropolis noticed it` explanation containing only
  observed WatchEvents, the daily maximum, active-day count, the exact
  selection threshold, and archive coverage;
- current stars, forks, commit and contributor aggregates;
- window WatchEvents and the latest covering lifecycle-week activity;
- AI relevance, lifecycle, availability, breakout, community, and district
  fields needed by the renderer;
- deterministic global and per-community ranks;
- empty repository and community edge arrays reserved for later verified graph
  derivation;
- renderer options for `TOP 5/10/25/50/100` and an initial visible budget of
  100 buildings.

Repositories below the renderer's selected TOP N remain in `city-v1`. Missing
metadata excludes an AI-related repository from the renderable repository list
and increments `source.excluded_missing_metadata`; it is not converted into a
zero-valued building.

`source.archive_coverage_complete` describes the historical GH Archive window
independently from `source.metadata_coverage_complete`. A complete archive may
therefore produce a partially enriched city when a current GitHub repository is
unavailable. `source.metadata_collected_at` identifies when current repository
descriptions and 30-day commit aggregates were retrieved. Those current values
must not be represented as historical facts about the activity window.

The explanation is a detection account, not a causal claim about why a
repository became popular. Raw README text is not copied into `city-v1`.
`description`, `detection_explanation`, and the split coverage fields were
added to the existing `city-v1` contract. Readers must continue to accept older
snapshots that omit these additive fields.

The first Next.js renderer validates the complete input with a Zod `city-v1`
schema before constructing any Three.js objects. Invalid or mismatched public
data produces an explicit loading error instead of a partially rendered city.

A complete seven-day scale check used the 2026-08-03 through 2026-08-10 UTC
window. All 168 hourly archives were collected, containing 24,419 unique
WatchEvents across 15,304 repositories with no archive coverage error. A daily
threshold of ten produced only 62 AI-related repositories, so the pre-enrichment
threshold was relaxed once to eight and the entire downstream pipeline was
rerun. This selected 181 repositories for full metadata, of which 177 were
currently accessible; rule analysis found exactly 80 AI-related repositories.
All 80 were written into 19 communities without padding or a post-analysis rank
cutoff. Combined city coverage remains partial because four selected GitHub
repositories were unavailable, while raw archive coverage is complete.

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
- Fully recovered GH Archive records remain eligible for normal semantic
  validation and are reported separately without reducing coverage.
- Unrecoverable GH Archive records are never counted as valid events and are
  exposed through candidate coverage errors.
- Repeated accepted GH Archive event IDs are counted once and reported through
  `event_integrity`; handled duplicates do not make coverage incomplete.
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
