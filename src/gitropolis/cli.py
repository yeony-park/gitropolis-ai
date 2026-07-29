from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

CONFIG_DIRECTORY = ".gitropolis"
CONFIG_FILENAME = "config.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gitropolis",
        description="Explore the momentum of the GitHub AI ecosystem as a city.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser(
        "init",
        help="Initialize local Gitropolis project files.",
    )
    init_parser.add_argument(
        "--directory",
        type=Path,
        default=Path.cwd(),
        help="Project directory to initialize. Defaults to the current directory.",
    )

    collect_parser = subparsers.add_parser(
        "collect",
        help="Collect public GitHub repository metadata.",
    )
    collect_parser.add_argument(
        "repositories",
        metavar="OWNER/REPOSITORY",
        nargs="+",
        help="One or more public GitHub repositories to collect.",
    )

    return parser


def initialize(directory: Path) -> Path:
    project_directory = directory.expanduser().resolve()
    data_directory = project_directory / CONFIG_DIRECTORY
    snapshots_directory = data_directory / "snapshots"
    config_path = data_directory / CONFIG_FILENAME

    snapshots_directory.mkdir(parents=True, exist_ok=True)
    if not config_path.exists():
        config = {
            "schema_version": "config-v1",
            "snapshot_directory": "snapshots",
        }
        config_path.write_text(
            json.dumps(config, indent=2) + "\n",
            encoding="utf-8",
        )

    return config_path


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "init":
        config_path = initialize(args.directory)
        print(f"Initialized Gitropolis at {config_path.parent}")
        return 0

    if args.command == "collect":
        parser.error("collect is not implemented yet")

    return 1
