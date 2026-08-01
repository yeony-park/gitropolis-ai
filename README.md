# Gitropolis

> Discover rising AI repositories before they become mainstream.

Gitropolis detects rising AI open-source repositories on GitHub and visualizes the ecosystem as a city.

<!-- 서비스 화면이 준비되면 스크린샷 또는 데모 GIF 추가 -->

<!--
![Gitropolis Preview](./docs/images/preview.png)
-->

## Motivation

New AI models, tools, and frameworks emerge constantly. By the time they appear on trend platforms or media channels, however, many have already gained significant attention.

Gitropolis began with the following questions:

* What if we could discover rapidly changing AI trends earlier than anyone else and review concise summaries of them?
* What if we could quickly understand the key aspects of recently growing repositories and jump directly to their original GitHub pages?
* Instead of browsing a simple leaderboard or subscribing to a newsletter, what if we could explore changes in the AI open-source ecosystem like a captivating city at night?

Gitropolis aims to answer these questions by combining Radar, which detects rapidly growing repositories at an early stage, with City, which presents the distribution of repositories and technology categories in a spatial environment.

## Overview

* Detect repositories based on Star growth velocity and acceleration rather than total Star count

* Visualize repositories as buildings and technology categories as city districts

* Use AI to summarize READMEs, technology stacks, key features, and the reasons behind repository growth

* Track growth trends and the initial detection date for each repository

* Compare detection dates with external content appearances to evaluate early-detection performance

* Provide direct links from repository summaries to the original GitHub repositories

## Why Gitropolis?

### Radar

Radar discovers repositories whose growth has recently begun to accelerate, rather than focusing only on repositories that are already well known.

Gitropolis looks beyond total star counts. It analyzes growth velocity, acceleration, consistency, and repository activity to detect momentum before widespread attention arrives.

### City

City represents repositories as a city rather than a ranked list, revealing how technology trends are distributed and how they change over time.

A list shows which repository ranks the highest. A city shows which technology districts are growing, where new buildings are appearing, and where attention is shifting.

## How It Works

1. Collect candidate AI-related repositories from GitHub.

2. Record changes in Stars, Forks, Contributors, Commits, and other metrics at regular intervals.

3. Calculate Star growth velocity and acceleration.

4. Classify repositories that satisfy growth and consistency criteria as Radar candidates.

5. Use AI to analyze and summarize repository READMEs and metadata.

6. Place buildings within the city based on each repository’s technology category and growth metrics.

7. Track when repositories appear in external content and evaluate how early Radar detected them.

## City Metaphor

| City Element   | GitHub Data                         |
| ------------- | ---------------------------------- |
| Building      | Individual GitHub repository                      |
| District      | Technology categories such as LLM, Agent, RAG, or Vision |
| Building height   | Number of Stars or growth score                    |
| Building growth   | Recent Star increase and growth velocity                 |
| Lighting      | Recent commit and contributor activity         |
| Building under construction | A recently created, rapidly growing repository            |
| Landmark    | Repositories established as standards in the ecosystem               |
| Declining building  | A repository whose activity has decreased over an extended period                   |

## Design Inspiration

A special shout-out to [Git City](https://github.com/srizzon/git-city), a creative project that turns GitHub profiles and activity into an interactive city. Its imaginative approach to visualizing developer activity inspired Gitropolis’s visual direction.

Gitropolis explores that city metaphor at the repository level: repositories become buildings and AI categories become districts. This makes it possible to explore growth signals, category trends, and shifts in attention across the AI open-source ecosystem.

## Target Users

* Developers and indie hackers who want to adopt new AI tools and frameworks early

* Tech YouTubers and newsletter creators who need to discover potential topics before they appear on other channels

* DevRel professionals and technology strategists who track open-source trends

* Researchers who analyze the structure and evolution of the AI ecosystem

## Success Metrics

### Leading Signal Precision

The percentage of Radar-detected repositories featured on major tech channels or the Hacker News front page within four weeks.

```text
Target: 40% or higher
```

### Average Lead Time

The average difference between the date Radar first detects a repository and the date the repository begins receiving significant coverage through external channels.

```text
Target: 14 days or more
```

```text
Lead time = External coverage date - Radar’s initial detection date
```

## Tech Stack

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-000000?logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=000000)
![Three.js](https://img.shields.io/badge/Three.js-000000?logo=threedotjs&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?logo=tailwindcss&logoColor=white)
![Python](https://img.shields.io/badge/Python-Data_Experiments-3776AB?logo=python&logoColor=white)

The Gitropolis product core uses TypeScript. The local CLI runs on Node.js, and
the web application uses Next.js, React, Three.js, and Tailwind CSS. Python is
reserved for data exploration and experimental analysis.

Runtime validation with Zod and JSON Schema will be introduced as the snapshot,
city, and report schemas are implemented and stabilized.

The local CLI will remain runnable without Docker. If the hosted web application
later requires independently deployable web, API, worker, or database services,
those services will be separated with Dockerfiles and Docker Compose.

## Getting Started

### Environment Variables

Gitropolis can collect public repository data without authentication. To use a
higher GitHub API request limit, set a fine-grained personal access token in the
`GITHUB_TOKEN` environment variable:

```bash
export GITHUB_TOKEN="your-token"
```

Never commit the token or include it in Issues, Pull Requests, logs, or command
arguments.

### Run

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

Initialize local Gitropolis files:

```bash
node dist/cli.js init
```

Collect one or more public repositories:

```bash
node dist/cli.js collect browser-use/browser-use
```

Without `GITHUB_TOKEN`, the command uses anonymous GitHub API access. When the
environment variable is present, it uses token authentication. Snapshots are
written under `.gitropolis/snapshots/` by default. Use `--output` to choose a
different path:

```bash
node dist/cli.js collect browser-use/browser-use \
  --output /tmp/gitropolis-snapshot.json
```

Discover repositories from a UTC-aligned GH Archive window without keyword
filters:

```bash
node dist/cli.js discover \
  --from 2026-07-30T00:00:00Z \
  --hours 24 \
  --top 10
```

The command streams hourly GH Archive files sequentially, aggregates
`WatchEvent` records by repository, enriches the highest-ranked candidates with
the GitHub REST collector, and writes `candidate-v1` under
`.gitropolis/candidates/`. A 24-hour run may download roughly hundreds of
megabytes. The default one-second interval and 60-second per-file timeout can be
adjusted with `--request-delay-ms` and `--request-timeout-ms`.

## Roadmap

* [x] Candidate GitHub repository collection pipeline
* [ ] Star time-series data storage
* [ ] Radar scoring based on growth velocity and acceleration
* [ ] Filtering of abnormal one-time Star spikes
* [ ] AI repository classification and summarization
* [ ] City-style 2D or 3D visualization
* [ ] Repository detail pages
* [ ] Links to original GitHub repositories
* [ ] Trend analysis by technology district
* [ ] Tracking of appearances in external content
* [ ] Evaluation of early-detection accuracy
* [ ] User watchlists and notifications
<!-- * [ ] Sponsor billboards and city-themed sponsorship features -->

## Contributing

Bug reports, feature suggestions, documentation improvements, and code contributions are welcome.

We are especially interested in experiments and suggestions for improving the Radar score, growth-signal detection, and evaluation methodology.

For contribution guidelines and the Pull Request process, please see CONTRIBUTING.md.

<!--
## Sponsorship

Gitropolis plans to accept sponsorship through GitHub Sponsors in the future to support the project’s development and operation.

Sponsorship funds will be used for:

* Data collection and storage infrastructure

* AI summarization model costs

* Operation of the official web service

* Research and evaluation of the Radar algorithm

* Improvements to the city visualization and user experience

An official sponsorship link will be added to this section once the GitHub Sponsors profile is active.

> Sponsorship never affects Radar scores, rankings, or repository recommendations.
-->

## License

Gitropolis is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).

You may use, modify, distribute, and host this software under the terms of the license. If you modify Gitropolis and make the modified version available to users over a network, you must provide those users with access to the corresponding source code as required by the AGPL-3.0.

See the [LICENSE](./LICENSE) file for the full license text.


## Disclaimer

Gitropolis’s Radar scores and AI-generated summaries are provided as reference information to support technology discovery.

Gitropolis does not guarantee the quality, security, long-term maintainability, or suitability for real-world adoption of any featured repository.
