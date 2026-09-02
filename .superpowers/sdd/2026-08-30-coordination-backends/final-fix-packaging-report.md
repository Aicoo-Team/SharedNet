# Final review packaging fix

## Scope

This fix packages the two third-party provenance files as wheel license files
without adding a project-wide license or asserting that SharedNet's original
code is MIT-licensed.

- `pyproject.toml` uses PEP 639 `project.license-files` and raises the isolated
  build minimum to `setuptools>=77.0.0`.
- `LICENSES/RAC-MIT.txt` is the exact MIT text from the inspected
  `runtime-agent-coordination` checkout, with `Copyright (c) 2026 Xisen Wang`.
- `THIRD_PARTY_NOTICES.md` remains the repository/commit-specific attribution
  notice for both upstream RAC repositories.
- `tests/test_packaging.py` builds with pip's `--no-index` and
  `--no-build-isolation`, inspects wheel contents and `METADATA`, installs into
  an isolated target, and uses a temporary directory for all build output.

## TDD and verification

The initial packaging test was genuinely RED: the baseline wheel built but did
not contain either file under `.dist-info/licenses/`. After adding PEP 639
configuration, the focused test passed with the supported local backend:

```text
PYTHONPATH=/var/folders/fv/lkh46jcn57d1dj9hwqd535kw0000gq/T/tmp.3JBzFz9z3M:src \
  python3.11 -m unittest -v tests.test_packaging
Ran 1 test in 3.266s
OK
```

The isolated smoke also passed: a wheel built with `--no-index` was installed
into a fresh virtual environment with `--no-index`, and
`sharednet coord list` returned all four canonical mechanisms plus the
`rac-adpt` alias.

## Toolchain constraint

The checkout's system Python 3.11 environment has setuptools 75.6.0. It cannot
consume `project.license-files` and correctly fails rather than silently
building an incomplete wheel. Verification used an already cached,
network-free temporary setuptools 84.0.0 path; the test's pip commands still
use `--no-index`, so they do not resolve or download dependencies.

## Content hashes

- `LICENSES/RAC-MIT.txt`: `b00def07d3c6748465930e8216fb39d8cad160283e55b511f3c6402eb4a5ff77`
- `THIRD_PARTY_NOTICES.md`: `b12d872ddbd139077748394871370d84cc9c692a0c2a1fc65382919e2c931461`
- `pyproject.toml`: `ba2619a1d1f3ea4d230ae2897398f6ef497ef582fab291c69518f133dae6c4c9`
- implementation commit: `0bf0a75` (`fix: package RAC provenance licenses`)
