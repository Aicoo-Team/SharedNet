# Packaging review follow-up

## Findings addressed

1. The former packaging test built directly from the checkout. Although its
   temporary wheel and installation were removed, setuptools left `build/` and
   `src/sharednet.egg-info/` in the repository.
2. The former `pip --target` check only asserted that `sharednet/cli.py`
   existed. Its generated `bin/sharednet` failed when executed because the
   target directory was not on that interpreter's import path.

## RED evidence

Running the former test with the supported bundled Python returned `OK` but
left both generated checkout paths behind:

```text
Ran 1 test in 1.033s
OK
build/
src/sharednet.egg-info/
```

Executing the former target-install console script returned:

```text
console_rc=1
ModuleNotFoundError: No module named 'sharednet'
```

Both generated checkout directories were removed before implementation and
were not committed.

## Implementation

The test now copies only the packaging inputs into a temporary source tree,
builds an sdist there through the local setuptools backend, verifies that the
sdist retains both provenance files, extracts it, and rebuilds a wheel from the
sdist with pip `--no-index --no-build-isolation --no-deps`.

The wheel is installed with `--no-index --no-deps` into a fresh temporary venv.
The test then executes that venv's actual `sharednet coord list` entry point and
asserts the four canonical mechanisms in order plus the `rac-adpt` alias. The
test asserts that neither checkout-generated path exists before or after the
run, and `TemporaryDirectory` removes all source, sdist, wheel, and venv output.

## Final verification

Toolchain:

```text
/Users/wangxiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3
Python 3.12.13
setuptools 84.0.0
```

Command and result:

```text
/Users/wangxiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  -m unittest -v tests.test_packaging
Ran 1 test in 6.234s
OK
```

`find build src/sharednet.egg-info ...` and `git status --short` produced no
output after the run.

## Hashes

- Implementation commit: `ba66bdb` (`test: make packaging verification hermetic`)
- `tests/test_packaging.py`: `5d28c9da890836029c792346200aa31b62e68229b5f8dccfde8b273286025847`
- `LICENSES/RAC-MIT.txt`: `b00def07d3c6748465930e8216fb39d8cad160283e55b511f3c6402eb4a5ff77`
- `THIRD_PARTY_NOTICES.md`: `b12d872ddbd139077748394871370d84cc9c692a0c2a1fc65382919e2c931461`
