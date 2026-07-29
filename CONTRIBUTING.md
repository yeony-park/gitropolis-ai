# Contributing to Gitropolis

Thank you for your interest in contributing to Gitropolis.

Gitropolis is currently in early development. Contribution guidelines and development workflows may change as the project evolves.

Gitropolis is a project that detects rapidly growing AI open-source repositories at an early stage and lets users explore changes in the technology ecosystem as a city.

Contributions are not limited to code. Bug reports, feature suggestions, documentation improvements, design feedback, and experiments with the Radar algorithm are all valuable.

## Ways to Contribute

You can contribute to the project in the following ways:

* Report bugs
* Suggest new features
* Improve the README and other documentation
* Improve accessibility and user experience
* Improve the city visualization and interactions
* Improve data collection reliability
* Improve repository classification and AI-generated summaries
* Improve the Radar score and growth-signal detection algorithm
* Add tests and optimize performance

## Before You Start

Check existing Issues and Pull Requests before starting to avoid duplicates.

You may submit a Pull Request directly for typo fixes or small documentation changes.

For larger changes—such as architectural changes, new dependencies, data model changes, or modifications to the Radar algorithm—open an Issue first so we can discuss the direction before implementation.

## Reporting a Bug

When reporting a bug, include as much of the following information as possible:

* The affected screen or feature
* Steps to reproduce the issue
* Expected behavior
* Actual behavior
* Your environment
* Error messages or logs
* Screenshots or recordings, if helpful

Do not include sensitive information such as API keys, tokens, or personal data in an Issue.

## Suggesting a Feature

When suggesting a feature, describe the problem you want to solve as well as the feature itself.

If possible, include:

* The current problem
* Who would benefit from the feature
* How the feature should work
* Expected benefits
* Potential tradeoffs or alternatives

## Contributing to Radar

Radar is a core feature of Gitropolis.

Rather than classifying a repository as trending based only on a large increase in stars, Radar aims to detect the earliest signals of growing interest as accurately as possible.

Proposals for changes to the Radar algorithm should include the following:

### Problem

Describe the problem with the current algorithm that your proposal aims to solve.

Examples:

* Older, well-established repositories consistently ranking too highly
* Abnormal star spikes caused by one-time viral attention
* Delayed detection of newly created repositories experiencing rapid growth
* Repositories in certain categories receiving an unfair advantage

### Proposed Method

Describe the proposed metrics, formulas, or pseudocode.

If possible, specify:

* Observation period
* Data used
* Normalization method
* Weights
* Thresholds
* Handling of exceptional cases

### Evaluation

Compare the current and proposed methods over the same data period.

Gitropolis evaluates changes using at least the following metrics:

* Leading Signal Precision
* Average Lead Time
* False Positive Rate
* Detection bias by category
* Bias between new and established repositories

### Reproducibility

Provide instructions, data periods, configuration values, and random seeds whenever possible so other contributors can reproduce the experiment.

Take care to prevent data leakage, such as using future data to make decisions at an earlier point in time.

## Development Workflow

### 1. Fork the Repository

Fork the Gitropolis repository.

### 2. Create a Branch

Create a branch with a name that clearly describes the purpose of your change.

```bash
git checkout -b feat/radar-acceleration-score
```

Recommended prefixes:

```text
feat/      New features
fix/       Bug fixes
docs/      Documentation changes
style/     Formatting changes
refactor/  Refactoring
test/      Test additions and changes
chore/     Configuration and maintenance
```

Use the same type names as the commit convention and write the description in
short kebab case:

```text
<type>/<short-kebab-case-description>
```

Examples:

```text
feat/github-repository-collector
fix/duplicate-repository-snapshots
docs/data-specification
```

### 3. Make Your Changes

Keep each Pull Request focused on a single purpose whenever possible.

Do not include unrelated formatting changes or large-scale refactoring.

### 4. Add Tests and Documentation

Add tests whenever your changes affect behavior.

Update the relevant documentation when usage or configuration changes.

### 5. Commit Your Changes

Write clear commit messages using the following format:

```text
<type>: <short description>
```

Use one of the following commit types:

| Type | Description | Example |
| --- | --- | --- |
| `feat` | Add a new feature or behavior | `feat: add repository watchlist` |
| `fix` | Fix incorrect behavior or a bug | `fix: prevent duplicate repository snapshots` |
| `docs` | Change documentation only | `docs: clarify Radar evaluation metrics` |
| `style` | Change formatting without affecting behavior | `style: apply lint formatting` |
| `refactor` | Improve code structure without changing behavior | `refactor: extract Radar scoring logic` |
| `test` | Add or update tests | `test: add Radar scoring tests` |
| `chore` | Update dependencies, tooling, or configuration | `chore: update dependencies` |

### 6. Open a Pull Request

Include the following in your Pull Request:

* The problem being solved
* Key changes
* Testing method and results
* Related Issues
* Screenshots or recordings for visual changes
* Evaluation results against the current method for Radar changes

## Pull Request Checklist

Before submitting a Pull Request, confirm that:

* [ ] The change has one clear purpose
* [ ] Related Issues are linked
* [ ] Tests have been run
* [ ] Necessary tests have been added
* [ ] Relevant documentation has been updated
* [ ] No secrets or personal information are included
* [ ] No unnecessary generated or large files are included
* [ ] Comparative evaluation results are included for Radar changes

## Review and Merge

Not every Pull Request will be merged.

Changes are reviewed based on the project’s scope, maintenance cost, technical direction, and user experience.

We may request changes or additional context during review. Proposals that do not align with the project’s direction may be closed after discussion.

The Gitropolis maintainers make the final decision on whether a Pull Request is merged.

## Merge Policy

Gitropolis allows merge commits and squash merges. Rebase merging is disabled.

- **Merge commit** is the default for feature and bug-fix pull requests whose individual commits are meaningful and well organized.
- **Squash merge** may be used for small changes, documentation updates, or pull requests containing temporary or fixup commits.
- The Maintainer determines the final merge method during review.

## Attribution

Merged contributions are attributed through the Git commit and Pull Request history.

Contributors to major features and Radar improvements may also be credited in release notes or project documentation.

## License

Gitropolis is licensed under `AGPL-3.0-only`.

By submitting a contribution to this repository, you agree that your contribution may be distributed under the same `AGPL-3.0-only` license.

## Community

Respect different experiences and perspectives.

Keep criticism focused on code, data, design, and reproducible evidence—not on individuals.
