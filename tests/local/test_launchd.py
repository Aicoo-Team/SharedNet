from __future__ import annotations

from pathlib import Path
from unittest import TestCase

from sharednet.local.launchd import LABEL, render_launchd_plist


class LaunchdTests(TestCase):
    def test_launchd_plist_contains_paths_but_no_raw_credentials(self) -> None:
        rendered = render_launchd_plist(
            Path("/opt/sharednet/bin/sharednet"),
            Path("/Users/demo/.sharednet/local.json"),
        )

        self.assertIn(LABEL, rendered)
        self.assertIn("local", rendered)
        self.assertIn("run", rendered)
        self.assertIn("/Users/demo/.sharednet/local.json", rendered)
        self.assertNotIn("connector_token", rendered)
        self.assertNotIn("runtime_token", rendered)
        self.assertNotIn("instance_token", rendered)


if __name__ == "__main__":
    import unittest

    unittest.main()
