"""Hermetic distribution checks for third-party provenance files."""

from __future__ import annotations

import email
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile


class PackagingTests(unittest.TestCase):
    def test_sdist_wheel_and_installed_cli_preserve_provenance(self) -> None:
        self._require_supported_build_backend()
        checkout = Path(__file__).resolve().parents[1]
        generated_checkout_paths = (checkout / "build", checkout / "src" / "sharednet.egg-info")
        self.assertFalse(any(path.exists() for path in generated_checkout_paths))

        with tempfile.TemporaryDirectory(prefix="sharednet-packaging-") as temporary:
            workspace = Path(temporary)
            source_copy = workspace / "source"
            self._copy_packaging_source(checkout, source_copy)

            sdist_dir = workspace / "sdist"
            sdist_dir.mkdir()
            subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "from setuptools.build_meta import build_sdist; import sys; print(build_sdist(sys.argv[1]))",
                    str(sdist_dir),
                ],
                cwd=source_copy,
                check=True,
                capture_output=True,
                text=True,
            )
            sdists = sorted(sdist_dir.glob("*.tar.gz"))
            self.assertEqual([sdist.name for sdist in sdists], ["sharednet-0.1.0.tar.gz"])
            with tarfile.open(sdists[0], "r:gz") as archive:
                sdist_names = set(archive.getnames())
                self.assertIn("sharednet-0.1.0/THIRD_PARTY_NOTICES.md", sdist_names)
                self.assertIn("sharednet-0.1.0/LICENSES/RAC-MIT.txt", sdist_names)
                extracted_dir = workspace / "extracted"
                archive.extractall(extracted_dir, filter="data")

            wheel_dir = workspace / "wheel"
            wheel_dir.mkdir()
            subprocess.run(
                [
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
                    str(extracted_dir / "sharednet-0.1.0"),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            wheels = sorted(wheel_dir.glob("*.whl"))
            self.assertEqual([wheel.name for wheel in wheels], ["sharednet-0.1.0-py3-none-any.whl"])
            self._assert_wheel_provenance(checkout, wheels[0])

            venv_dir = workspace / "venv"
            probe_cwd = workspace / "empty-probe-cwd"
            probe_cwd.mkdir()
            isolated_env = os.environ.copy()
            isolated_env.pop("PYTHONPATH", None)
            isolated_env.pop("PYTHONHOME", None)
            isolated_env["PYTHONNOUSERSITE"] = "1"
            subprocess.run(
                [sys.executable, "-m", "venv", str(venv_dir)],
                check=True,
                capture_output=True,
                text=True,
            )
            venv_python = venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            subprocess.run(
                [
                    str(venv_python),
                    "-m",
                    "pip",
                    "install",
                    "--no-deps",
                    "--no-index",
                    "--disable-pip-version-check",
                    str(wheels[0]),
                ],
                cwd=probe_cwd,
                env=isolated_env,
                check=True,
                capture_output=True,
                text=True,
            )
            imported = subprocess.run(
                [
                    str(venv_python),
                    "-c",
                    "from pathlib import Path; import sharednet; print(Path(sharednet.__file__).resolve())",
                ],
                cwd=probe_cwd,
                env=isolated_env,
                check=True,
                capture_output=True,
                text=True,
            )
            imported_path = Path(imported.stdout.strip())
            self.assertTrue(imported_path.is_relative_to(venv_dir.resolve()))
            self.assertFalse(imported_path.is_relative_to(checkout.resolve()))
            sharednet_cli = venv_dir / ("Scripts/sharednet.exe" if os.name == "nt" else "bin/sharednet")
            result = subprocess.run(
                [str(sharednet_cli), "coord", "list"],
                cwd=probe_cwd,
                env=isolated_env,
                check=True,
                capture_output=True,
                text=True,
            )
            listing = json.loads(result.stdout)
            self.assertEqual(
                [mechanism["id"] for mechanism in listing["mechanisms"]],
                ["discovery-and-use", "rac-rge", "rac-adaptive", "peer-forum"],
            )
            self.assertEqual(listing["aliases"], {"rac-adpt": "rac-adaptive"})

        self.assertFalse(any(path.exists() for path in generated_checkout_paths))

    def _require_supported_build_backend(self) -> None:
        requirement = "setuptools>=77.0.0"
        install_hint = "install the declared test extra with: python -m pip install -e '.[test]'"
        try:
            import setuptools
        except ImportError as error:
            self.skipTest(
                f"packaging verification requires {requirement}; setuptools could not be imported ({error}); {install_hint}"
            )
        from setuptools._vendor.packaging.version import Version

        if Version(setuptools.__version__) < Version("77.0.0"):
            self.skipTest(
                f"packaging verification requires {requirement}; "
                f"current setuptools is {setuptools.__version__}; {install_hint}"
            )

    @staticmethod
    def _copy_packaging_source(checkout: Path, destination: Path) -> None:
        destination.mkdir()
        for filename in ("pyproject.toml", "README.md", "THIRD_PARTY_NOTICES.md"):
            shutil.copy2(checkout / filename, destination / filename)
        shutil.copytree(checkout / "LICENSES", destination / "LICENSES")
        shutil.copytree(
            checkout / "src",
            destination / "src",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.egg-info"),
        )

    def _assert_wheel_provenance(self, checkout: Path, wheel: Path) -> None:
        with zipfile.ZipFile(wheel) as archive:
            names = set(archive.namelist())
            self.assertEqual(
                {name for name in names if ".dist-info/licenses/" in name},
                {
                    "sharednet-0.1.0.dist-info/licenses/THIRD_PARTY_NOTICES.md",
                    "sharednet-0.1.0.dist-info/licenses/LICENSES/RAC-MIT.txt",
                },
            )
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


if __name__ == "__main__":
    unittest.main()
