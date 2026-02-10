# DEPRECATED

This directory has been superseded by the unified `e2e-tests/` directory.

All platform-specific helpers and configs have been moved to `e2e-tests/platforms/`:
- `windows_helper.py` -> `e2e-tests/platforms/windows_helper.py`
- `config.py` -> `e2e-tests/platforms/windows_config.py`
- `conftest.py` -> merged into `e2e-tests/conftest.py`
- Test files -> canonical versions in `e2e-tests/tests/`

To run Windows E2E tests with the unified structure:
```bash
cd e2e-tests
ZAJEL_TEST_PLATFORM=windows pytest
```

This directory will be removed in a future cleanup.
