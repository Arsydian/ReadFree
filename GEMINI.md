# Project Rules & Guidelines - ReadFree

## Automatic Build Version Incrementation
Whenever any new feature, bug fix, security patch, or architecture revision is made in this project:
1. **Always increment the build version** in `package.json` automatically before committing:
   - Increment **PATCH** (`1.0.0` -> `1.0.1`) for bug fixes, refactoring, and minor adjustments.
   - Increment **MINOR** (`1.0.0` -> `1.1.0`) for new features, new protocols (such as Amazon MAP device registration), and major architectural additions.
   - Increment **MAJOR** (`1.0.0` -> `2.0.0`) for breaking changes.
2. Synchronize version numbers across:
   - `package.json`
   - `README.md` version badges
   - Dynamic UI titlebar badge via `window.api.appVersion`
3. Never leave placeholder or mock authentication strings in production code. Always verify cryptographic signatures and network contracts with automated tests.
