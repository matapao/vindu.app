# Vindu.app

Vindu.app is the default web and Electron workspace for the Vindu SDK.
Open a task in Activity to resume its conversation, panes and selected context.
The SDK renders tool inputs and results. Celler handles connector permissions and calls.

## Run locally

Use Git, Node.js 24.11 or later, and pnpm. Place the `vindu.app`, `vindu` and `celler` checkouts side by side.
From `vindu.app`, build the three local checkouts and start the web workspace.

```sh
node scripts/bootstrap.mjs --local
pnpm start
```

For Electron, fetch the runtime once and launch the desktop app.

```sh
pnpm --dir frame electron:fetch
pnpm --dir frame start
```

For a fresh clone or CI, run `node scripts/bootstrap.mjs`. First set both public Git URLs
and full commit SHAs in [dependencies.json](dependencies.json). The build verifies each checkout and uses frozen lockfiles.

## Connect a processor

A host supplies its processors and task connection through `startApp({ processors, connect })` in `src/app.ts`.
This connection is required to send a prompt. The host owns the account, model and conversation.
For a layout-only coordinator, register the open task’s `ui.layoutMcpServer` with its MCP client.
It exposes pane geometry without sharing pane contents.

See [AGENTS.md](AGENTS.md) for checks and local packaging commands.
