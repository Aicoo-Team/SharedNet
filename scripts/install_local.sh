#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_root="${SHAREDNET_INSTALL_ROOT:-${HOME}/.local/share/sharednet}"
binary_dir="${SHAREDNET_BIN_DIR:-${HOME}/.local/bin}"

validate_target() {
  local value="$1"
  local label="$2"
  if [[ -z "${value}" || "${value}" == "/" || "${value}" == "${HOME}" || "${value}" == *'$'* ]]; then
    printf 'Unsafe %s: %s\n' "${label}" "${value}" >&2
    exit 2
  fi
}

validate_target "${install_root}" "install root"
validate_target "${binary_dir}" "binary directory"

link_path="${binary_dir}/sharednet"
if [[ -e "${link_path}" && ! -L "${link_path}" ]]; then
  printf 'Refusing to replace non-symlink: %s\n' "${link_path}" >&2
  exit 2
fi

(
  cd "${script_dir}"
  shasum -a 256 -c SHA256SUMS
)

install_parent="$(dirname "${install_root}")"
mkdir -p "${install_parent}" "${binary_dir}"
staging_root="$(mktemp -d "${install_parent}/.sharednet-install.XXXXXX")"
backup_root="${install_root}.previous.$$"
cleanup() {
  if [[ -d "${staging_root}" ]]; then
    rm -rf "${staging_root}"
  fi
}
trap cleanup EXIT

cp -R "${script_dir}/bin" "${staging_root}/"
cp -R "${script_dir}/skills" "${staging_root}/"
cp -R "${script_dir}/LICENSES" "${staging_root}/"
cp "${script_dir}/THIRD_PARTY_NOTICES.md" "${staging_root}/"
cp "${script_dir}/SHA256SUMS" "${staging_root}/"

if [[ -e "${install_root}" ]]; then
  if [[ -e "${backup_root}" ]]; then
    printf 'Refusing existing backup path: %s\n' "${backup_root}" >&2
    exit 2
  fi
  mv "${install_root}" "${backup_root}"
  if ! mv "${staging_root}" "${install_root}"; then
    mv "${backup_root}" "${install_root}"
    exit 1
  fi
  rm -rf "${backup_root}"
else
  mv "${staging_root}" "${install_root}"
fi

ln -sfn "${install_root}/bin/sharednet" "${link_path}"
printf 'Installed SharedNet Local at %s\n' "${install_root}"
