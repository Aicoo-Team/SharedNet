"""Offline distribution checks for third-party provenance files."""

from __future__ import annotations

import email
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


class PackagingTests(unittest.TestCase):
    def test_offline_wheel_contains_provenance_files_and_metadata(self) -> None:
        checkout = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="sharednet-wheel-") as temporary:
            wheel_dir = Path(temporary) / "wheel"
            wheel_dir.mkdir()
            command = [
                sys.executable,
                "-m",
                "pip",
                "wheel",
                "--no-deps",
                "--no-build-isolation",
                "--no-index",
                "--disable-pip-version-check",
                "--wheel-dir",
                str(wheel_dir),
                str(checkout),
            ]
            subprocess.run(command, check=True, capture_output=True, text=True)

            wheels = sorted(wheel_dir.glob("*.whl"))
            self.assertEqual([wheel.name for wheel in wheels], ["sharednet-0.1.0-py3-none-any.whl"])
            with zipfile.ZipFile(wheels[0]) as archive:
                names = set(archive.namelist())
                license_names = {
                    name
                    for name in names
                    if ".dist-info/licenses/" in name
                }
                self.assertEqual(
                    license_names,
                    {
                        "sharednet-0.1.0.dist-info/licenses/THIRD_PARTY_NOTICES.md",
                        "sharednet-0.1.0.dist-info/licenses/LICENSES/RAC-MIT.txt",
                    },
                )
                rac_license = archive.read("sharednet-0.1.0.dist-info/licenses/LICENSES/RAC-MIT.txt").decode()
                self.assertIn("MIT License\n\nCopyright (c) 2026 Xisen Wang\n", rac_license)
                self.assertEqual(
                    archive.read("sharednet-0.1.0.dist-info/licenses/LICENSES/RAC-MIT.txt"),
                    (checkout / "LICENSES" / "RAC-MIT.txt").read_bytes(),
                )
                metadata = email.message_from_bytes(archive.read("sharednet-0.1.0.dist-info/METADATA"))
                self.assertEqual(
                    set(metadata.get_all("License-File")),
                    {"LICENSES/RAC-MIT.txt", "THIRD_PARTY_NOTICES.md"},
                )
                self.assertIsNone(metadata.get("License"))

            isolated_target = Path(temporary) / "isolated-install"
            isolated_target.mkdir()
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "--no-deps",
                    "--no-index",
                    "--target",
                    str(isolated_target),
                    str(wheels[0]),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertTrue((isolated_target / "sharednet" / "cli.py").exists())

            self.assertEqual(list(wheel_dir.iterdir()), [wheels[0]])


if __name__ == "__main__":
    unittest.main()
