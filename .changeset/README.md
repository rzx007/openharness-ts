# Changesets

Use `pnpm changeset` to create a release note file whenever a package change should ship to npm.

Typical flow:

1. Make code changes.
2. Run `pnpm changeset`.
3. Choose the packages that changed and the release type.
4. Commit the generated `.changeset/*.md` file with your code.
5. Merge to `main`.

On `main`, the release workflow will either:

- open or update a release PR with version bumps, or
- publish to npm when a release PR has already been merged.

Packages that should never be published should set `"private": true` in their `package.json`.
