# Working on Vindu.app

Keep web and Electron behavior in the shared app. The Electron host lives in `frame/`.
Shared rendering and UI sessions belong in `../vindu`. Connector execution and accounting belong in `../celler`.
The host controls device permissions and processor access. Keep harness prompts and tool descriptions with the consumer.

## Code style

- Give each module one responsibility. Aim for 300 physical lines. `pnpm lint` enforces 500 for
  handwritten source, tests and configuration, including comments and blank lines.
- Use descriptive names, named exports and type-only imports. Keep related state and operations together.
- Prefer straightforward control flow. Keep semantic markup, presentation and data handling distinct.

## Verify changes

Run from the app root after the setup in [README.md](README.md).

```sh
pnpm exec playwright install chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm test:browser
pnpm check:security
```

`pnpm check:security` checks lockfile sources, hidden characters, licences, secrets, Semgrep, zizmor and actionlint.
CI runs it with `--strict`, and daily with `--live` for advisories. On public repositories, CI also runs CodeQL’s
security-extended queries for JavaScript, TypeScript and GitHub Actions, and OpenSSF Scorecard.

Run the desktop checks on macOS from `frame/`.

```sh
pnpm electron:fetch
pnpm typecheck
pnpm build
pnpm test
pnpm pack:app --dir
pnpm test:packed
pnpm pack:app --client --dir
pnpm test:client
```

Tests use isolated profiles and do not call models. For manual checks, set `VINDU_USER_DATA` to a temporary
directory and choose an unused `VINDU_PORT`. Report which checks passed and which could not run.
Leave pushes and merges to the maintainer.
