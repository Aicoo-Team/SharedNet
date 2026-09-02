#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
python_command="${PYTHON:-python3}"
output_dir="${SHAREDNET_DIST_DIR:-${repository_root}/dist}"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/sharednet-build.XXXXXX")"
trap 'rm -rf "${temporary_root}"' EXIT

mkdir -p "${output_dir}"
"${python_command}" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name sharednet \
  --paths "${repository_root}/src" \
  --distpath "${temporary_root}/pyinstaller-dist" \
  --workpath "${temporary_root}/pyinstaller-work" \
  --specpath "${temporary_root}" \
  "${repository_root}/scripts/sharednet_entry.py"

bundle_root="${temporary_root}/sharednet-local"
mkdir -p "${bundle_root}/bin" "${bundle_root}/skills" "${bundle_root}/LICENSES"
cp "${temporary_root}/pyinstaller-dist/sharednet" "${bundle_root}/bin/sharednet"
cp -R "${repository_root}/src/sharednet/local/assets/sharednet-room" "${bundle_root}/skills/"
cp "${repository_root}/scripts/install_local.sh" "${bundle_root}/install.sh"
cp "${repository_root}/THIRD_PARTY_NOTICES.md" "${bundle_root}/"
cp "${repository_root}/LICENSES/RAC-MIT.txt" "${bundle_root}/LICENSES/"

(
  cd "${bundle_root}"
  shasum -a 256 bin/sharednet skills/sharednet-room/SKILL.md > SHA256SUMS
)

archive="${output_dir}/sharednet-local-darwin-arm64.tar.gz"
COPYFILE_DISABLE=1 tar -C "${temporary_root}" -czf "${archive}" sharednet-local
shasum -a 256 "${archive}" > "${archive}.sha256"
printf '%s\n' "${archive}"
