#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
python_command="${PYTHON:-python3}"

cd "${repository_root}"
SHAREDNET_RUN_LIVE_E2E=1 PYTHONPATH="${repository_root}/src${PYTHONPATH:+:${PYTHONPATH}}" \
  "${python_command}" -m unittest tests.test_local_communication_e2e -v
