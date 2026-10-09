# Automatic Version Increment Rule

## Core Directive
Whenever features, bug fixes, refactors, or modifications are implemented in the project, the build version MUST be automatically incremented without waiting for user prompting:

1. **Semantic Versioning Standards:**
   - **PATCH** (`x.y.Z`): For bug fixes, optimizations, dependency updates, and maintenance changes.
   - **MINOR** (`x.Y.0`): For new features, newly supported platforms, new API endpoints, or significant capability additions.
   - **MAJOR** (`X.0.0`): For breaking architectural changes, major UI overhauls, or incompatible API shifts.

2. **Synchronization Requirements:**
   - Update `package.json` (or the equivalent version manifest: `pyproject.toml`, `Cargo.toml`, `pom.xml`, etc.).
   - Ensure the application UI (titlebar badges, about modals) and documentation (e.g., `README.md` badges) reflect the updated version.
   - Commit the version increment alongside the feature or fix commit.
