from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from gitropolis.cli import initialize


class InitializeTests(unittest.TestCase):
    def test_initialize_creates_config_and_snapshot_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            project_directory = Path(temporary_directory)

            config_path = initialize(project_directory)

            self.assertEqual(
                json.loads(config_path.read_text(encoding="utf-8")),
                {
                    "schema_version": "config-v1",
                    "snapshot_directory": "snapshots",
                },
            )
            self.assertTrue((config_path.parent / "snapshots").is_dir())

    def test_initialize_preserves_existing_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            project_directory = Path(temporary_directory)
            config_path = project_directory / ".gitropolis" / "config.json"
            config_path.parent.mkdir(parents=True)
            config_path.write_text('{"custom": true}\n', encoding="utf-8")

            initialize(project_directory)

            self.assertEqual(
                config_path.read_text(encoding="utf-8"),
                '{"custom": true}\n',
            )


if __name__ == "__main__":
    unittest.main()
