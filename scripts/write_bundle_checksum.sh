#!/usr/bin/env bash
set -euo pipefail

archive_name="sharednet-local-darwin-arm64.tar.gz"

if [[ "$#" -ne 1 ]]; then
  printf 'usage: %s /path/to/%s\n' "$0" "${archive_name}" >&2
  exit 64
fi

archive_path="$1"
if [[ "$(basename "${archive_path}")" != "${archive_name}" ]]; then
  printf 'archive basename must be exactly %s\n' "${archive_name}" >&2
  exit 64
fi

archive_directory="$(cd "$(dirname "${archive_path}")" && pwd -P)"
canonical_archive="${archive_directory}/${archive_name}"
if [[ ! -f "${canonical_archive}" || -L "${canonical_archive}" ]]; then
  printf 'archive must be a regular file\n' >&2
  exit 66
fi

(
  cd "${archive_directory}"
  shasum -a 256 "${archive_name}" > "${archive_name}.sha256"
)
