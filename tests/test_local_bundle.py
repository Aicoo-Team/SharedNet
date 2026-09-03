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
    def build_fixture_bundle(self, root: Path) -> Path:
        fake_python = root / "fake-python"
        fake_python.write_text(
            """#!/bin/sh
set -eu
distpath=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--distpath' ]; then
    shift
    distpath="$1"
  fi
  shift
done
mkdir -p "$distpath"
printf '#!/bin/sh\nexit 0\n' > "$distpath/sharednet"
chmod 755 "$distpath/sharednet"
""",
            encoding="utf-8",
        )
        fake_python.chmod(0o755)
        output = root / "dist"
        environment = os.environ.copy()
        environment.update(
            {
                "PYTHON": str(fake_python),
                "SHAREDNET_DIST_DIR": str(output),
            }
        )
        completed = subprocess.run(
            ["bash", str(REPOSITORY_ROOT / "scripts" / "build_local_bundle.sh")],
            text=True,
            capture_output=True,
            check=False,
            env=environment,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        extracted = root / "extracted"
        extracted.mkdir()
        subprocess.run(
            [
                "tar",
                "-xzf",
                str(output / "sharednet-local-darwin-arm64.tar.gz"),
                "-C",
                str(extracted),
            ],
            check=True,
        )
        return extracted / "sharednet-local"

    @staticmethod
    def manifest_paths(bundle: Path) -> set[str]:
        return {
            line.split(maxsplit=1)[1].lstrip("*")
            for line in (bundle / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
            if line.strip()
        }

    @staticmethod
    def payload_paths(bundle: Path) -> set[str]:
        return {
            path.relative_to(bundle).as_posix()
            for path in bundle.rglob("*")
            if path.is_file() and path.name != "SHA256SUMS"
        }

    @staticmethod
    def write_complete_manifest(bundle: Path) -> None:
        lines = []
        for relative in sorted(LocalBundleTests.payload_paths(bundle)):
            digest = hashlib.sha256((bundle / relative).read_bytes()).hexdigest()
            lines.append(f"{digest}  {relative}\n")
        (bundle / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")

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
            (bundle / "skills" / "sharednet-room" / "references").mkdir(parents=True)
            (bundle / "LICENSES").mkdir()
            binary = bundle / "bin" / "sharednet"
            skill = bundle / "skills" / "sharednet-room" / "SKILL.md"
            command_contract = (
                bundle
                / "skills"
                / "sharednet-room"
                / "references"
                / "command-contract.md"
            )
            binary.write_text("#!/bin/sh\nprintf 'sharednet demo\\n'\n", encoding="utf-8")
            binary.chmod(0o755)
            skill.write_text("# SharedNet Room\n", encoding="utf-8")
            command_contract.write_text("# SharedNet Room commands\n", encoding="utf-8")
            (bundle / "THIRD_PARTY_NOTICES.md").write_text("notices\n", encoding="utf-8")
            (bundle / "LICENSES" / "RAC-MIT.txt").write_text("license\n", encoding="utf-8")
            shutil.copy2(REPOSITORY_ROOT / "scripts" / "install_local.sh", bundle / "install.sh")
            self.write_complete_manifest(bundle)

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
                (
                    install_root
                    / "skills"
                    / "sharednet-room"
                    / "references"
                    / "command-contract.md"
                ).read_text(),
                command_contract.read_text(),
            )
            self.assertEqual(
                (binary_dir / "sharednet").resolve(),
                (install_root / "bin" / "sharednet").resolve(),
            )

    def test_built_manifest_covers_every_bundle_payload(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sharednet-bundle-coverage-") as directory:
            bundle = self.build_fixture_bundle(Path(directory))

            self.assertEqual(self.manifest_paths(bundle), self.payload_paths(bundle))

    def test_built_manifest_rejects_a_tampered_command_contract(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sharednet-bundle-tamper-") as directory:
            bundle = self.build_fixture_bundle(Path(directory))
            command_contract = (
                bundle
                / "skills"
                / "sharednet-room"
                / "references"
                / "command-contract.md"
            )
            command_contract.write_text("tampered instructions\n", encoding="utf-8")

            completed = subprocess.run(
                ["shasum", "-a", "256", "-c", "SHA256SUMS"],
                cwd=bundle,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)

    def test_installer_rejects_a_manifest_that_omits_an_instruction(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sharednet-manifest-omission-") as directory:
            root = Path(directory)
            bundle = self.build_fixture_bundle(root)
            manifest = bundle / "SHA256SUMS"
            manifest.write_text(
                "".join(
                    line
                    for line in manifest.read_text(encoding="utf-8").splitlines(keepends=True)
                    if not line.endswith("skills/sharednet-room/references/command-contract.md\n")
                ),
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment.update(
                {
                    "SHAREDNET_INSTALL_ROOT": str(root / "installed" / "sharednet"),
                    "SHAREDNET_BIN_DIR": str(root / "commands"),
                }
            )

            completed = subprocess.run(
                ["bash", str(bundle / "install.sh")],
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertFalse((root / "installed" / "sharednet").exists())


if __name__ == "__main__":
    import unittest

    unittest.main()
