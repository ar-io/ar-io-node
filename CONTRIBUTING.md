# Contributing Guidelines

NOTE: Contribution implies licensing under the terms of [LICENSE]
(AGPL-3).

## Pull Request Checklist

- Confirm the PR is against the `develop` branch.
- Ensure commit messages follow the [conventional commits] style.
- Ensure commit messages adequately explain the reasons for the changes.
- Ensure changes are consistent with the [principles and practices]
  outlined in the README.
- Run [lint].
- Run the [unit tests].

## Writing Good Commit Messages

- Keep the first line short but informative.
- Provide explanation of why the change is being made in the commit message
  body.
- Prefer copying relevant information into the commit body over linking to them.
- Consider whether your commit message includes enough detail for someone to be
  able to understand it in the future.

## Branching Workflow

- New branches are created on `develop`.
- When complete new branches are merged to `develop`.
- At release time, `develop` is merged into `main`.

[license]: ./LICENSE
[conventional commits]: https://www.conventionalcommits.org/en/v1.0.0/
[principles and practices]: https://github.com/ar-io/ar-io-node/tree/develop#principles-and-practices
[lint]: https://github.com/ar-io/ar-io-node/tree/develop#run-lint
[unit tests]: https://github.com/ar-io/ar-io-node/tree/develop#run-tests
