# Vindu.app

Vindu.app is an app of its own. It installs itself as an Electron app, or as a web app from its page in the browser.
Either way it opens Desktop, where it runs its own tasks. Activity lists them, and a task resumes its conversation,
panes and selected context. Settings, in Activity's head, sets the processors its tasks may use, their daily budget,
and the phone paired with it.

## Run locally

Use Git, Node.js 24.11 or later, and pnpm. `node scripts/bootstrap.mjs` checks out the revisions pinned in
[dependencies.json](dependencies.json) beside this checkout, builds them with frozen lockfiles, and builds the app.
With `--local`, it builds the checkouts beside this one as they are.

```sh
node scripts/bootstrap.mjs --local
pnpm start
```

`pnpm start` serves Desktop and opens it in the browser, which can install it as a web app.
For the Electron app, fetch the runtime once and launch it.

```sh
pnpm --dir frame electron:fetch
pnpm --dir frame start
```

## Processors

A task runs on a processor. `startApp` in `src/app.ts` takes the processors (`processors`), how a task connects to
the one it runs on (`connect`), and what Settings says each still needs (`checkProcessors`). `pnpm start` and the
Electron app give it the claude and codex CLIs found on this computer as they start (`src/processors.ts`). Each turn
runs the task's CLI in the task's folder, on the CLI's own model and sign-in, and asks the person in the task's thread
before the CLI acts. Settings says which CLI is missing, and what one still needs: Codex signs in for Vindu in a home
of its own, the `codex` folder in the app's data.

See [AGENTS.md](AGENTS.md) for checks and packaging.
