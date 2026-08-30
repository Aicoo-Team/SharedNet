# Final packaging and documentation hardening

## Findings addressed

### Honest build-test prerequisite

`pyproject.toml` now declares the packaging test prerequisite explicitly as the
`test` optional dependency `setuptools>=77.0.0`. The packaging test checks that
prerequisite at runtime. A missing or older backend produces a precise unittest
skip with the `python -m pip install -e '.[test]'` installation hint; the test
does not download, bootstrap, or contact an index itself.

RED evidence from the default Python 3.13 interpreter before the fix was an
unhandled `CalledProcessError` from the sdist subprocess because setuptools was
not installed. After the fix:

```text
PYTHONPATH=src python3 -m unittest discover
Ran 152 tests in 0.225s
OK (skipped=2)
```

The two skips are the opt-in real Codex E2E and the packaging test's declared
setuptools prerequisite. Python 3.11 with setuptools 75.6.0 also skips with the
exact installed version in its reason.

### Installed-distribution isolation

Before the fix, running the packaging test with the checkout `src` directory
in `PYTHONPATH` still returned `OK`, so its console proof could silently import
SharedNet from the checkout.

Every installed-distribution import and console probe now:

- removes `PYTHONPATH` and `PYTHONHOME`;
- disables the user site;
- runs from a fresh empty temporary working directory;
- executes the venv's actual `sharednet` entry point; and
- separately imports `sharednet` with the venv Python and asserts the resolved
  module path is inside the venv and outside the checkout.

Final hostile-environment verification used the required bundled runtime:

```text
PYTHONPATH=<checkout>/src \
  /Users/wangxiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  -m unittest -v tests.test_packaging
Ran 1 test in 5.623s
OK
```

No checkout `build/` or `src/sharednet.egg-info/` appeared. Wheel and sdist
builds remained temporary and offline with `--no-index` and
`--no-build-isolation`.

The CLI smoke returned:

```json
{"aliases":{"rac-adpt":"rac-adaptive"},"mechanisms":[{"id":"discovery-and-use"},{"id":"rac-rge"},{"id":"rac-adaptive"},{"id":"peer-forum"}]}
```

### README contract

The README now provides an explicit editable-install step before CLI commands,
names the packaging-test extra, documents request-wide wall-time, turn, and
predicted-cost consumption plus depth/participant/retry limits, scopes
`max_disclosure_bytes` to the serialized task payload, distinguishes logical
`CandidateMode` authority from native Codex child transport, and records that
`communicate()` buffers process output before `max_capture_bytes` can reject it.

## Hashes

- Implementation commit: `191b5b4` (`test: harden packaging prerequisites and isolation`)
- `pyproject.toml`: `8056f2d55cdee7af4f4a02375033479df35bf8248a391d61af0ef767cf8a752a`
- `tests/test_packaging.py`: `34da4b623bf8a29e536b6bc9f62dbd925f1f77653aaddcbaf48b3e7e6fc7ba84`
- `README.md`: `89b6b2aa663c1b59e361c22cd60afe8b4aa53bfa6dbfa68214160c02fc87eba9`
