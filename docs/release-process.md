# Release Process

## Release

1. Ensure all relevant changes are merged into `develop`.
1. Review `CHANGELOG.md` and ensure all changes have been documented.
1. Add the release date and release number to `CHANGELOG.md`.
1. Remove the "-pre" suffix from the `release` constant in `src/version.ts`.
1. Commit the version change and push to `develop`.
1. Once images builds are complete, set the image tags in `.env`.
1. Tag the release in git.
1. Merge to `main`.

## Post Release

1. Switch back to the `develop` branch.
1. Bump the release number and add a "-pre" suffice to `release` constant in
   `src/version.ts`.
1. Create a new `[Unreleased]` entry in `CHANGELOG.md`.
