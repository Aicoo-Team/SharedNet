from __future__ import annotations

from pathlib import Path
import hashlib
import os
import shutil
import subprocess
import tempfile
from unittest import TestCase


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


class LocalBundleTests(TestCase):
    def test_bundle_scripts_parse_and_include_the_room_skill(self) -> None:
        build = REPOSITORY_ROOT / "scripts" / "build_local_bundle.sh"
        install = REPOSITORY_ROOT / "scripts" / "install_local.sh"
        skill = (
            REPOSITORY_ROOT
            / "src"
            / "sharednet"
            / "local"
            / "assets"
            / "sharednet-room"
            / "SKILL.md"
        )
        for script in (build, install):
            completed = subprocess.run(
                ["bash", "-n", str(script)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(skill.is_file())

    def test_installer_verifies_manifest_and_installs_into_explicit_roots(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sharednet-installer-") as directory:
            root = Path(directory)
            bundle = root / "bundle"
            (bundle / "bin").mkdir(parents=True)
            (bundle / "skills" / "sharednet-room").mkdir(parents=True)
            (bundle / "LICENSES").mkdir()
            binary = bundle / "bin" / "sharednet"
            skill = bundle / "skills" / "sharednet-room" / "SKILL.md"
            binary.write_text("#!/bin/sh\nprintf 'sharednet demo\\n'\n", encoding="utf-8")
            binary.chmod(0o755)
            skill.write_text("# SharedNet Room\n", encoding="utf-8")
            (bundle / "THIRD_PARTY_NOTICES.md").write_text("notices\n", encoding="utf-8")
            (bundle / "LICENSES" / "RAC-MIT.txt").write_text("license\n", encoding="utf-8")
            shutil.copy2(REPOSITORY_ROOT / "scripts" / "install_local.sh", bundle / "install.sh")
            manifest_lines = []
            for relative in ("bin/sharednet", "skills/sharednet-room/SKILL.md"):
                digest = hashlib.sha256((bundle / relative).read_bytes()).hexdigest()
                manifest_lines.append(f"{digest}  {relative}\n")
            (bundle / "SHA256SUMS").write_text("".join(manifest_lines), encoding="utf-8")

            install_root = root / "installed" / "sharednet"
            binary_dir = root / "commands"
            environment = os.environ.copy()
            environment.update(
                {
                    "HOME": str(root / "home"),
                    "SHAREDNET_INSTALL_ROOT": str(install_root),
                    "SHAREDNET_BIN_DIR": str(binary_dir),
                }
            )
            completed = subprocess.run(
                ["bash", str(bundle / "install.sh")],
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual((install_root / "bin" / "sharednet").read_text(), binary.read_text())
            self.assertEqual(
                (binary_dir / "sharednet").resolve(),
                (install_root / "bin" / "sharednet").resolve(),
            )


if __name__ == "__main__":
    import unittest

    unittest.main()
