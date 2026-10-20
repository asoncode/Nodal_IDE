# Nodal

Nodal is a desktop coding workspace where you can edit files and build visual workflows for Claude and Codex. Open a folder, work in the editor, and connect agents, commands, tests, and approval steps on a canvas. You can follow each run as it happens, review the changes, and decide what to apply to your project.

It's an early, working version. The core editing and workflow features are in place, and the desktop app has been built on Apple Silicon macOS. Some editor features and release packaging are still unfinished; see [Known limitations](KNOWN_LIMITATIONS.md).

![Nodal showing a workflow and its execution history](docs/screenshots/nodal.png)

## What you can do

- **Open and edit local folders.** Browse files in Explorer, edit them with Monaco, and save changes to disk. The desktop app includes a native folder picker and separate workspace windows.
- **Build workflows visually.** Add agents, commands, conditions, parallel branches, test checks, bounded retry loops, and human approvals. Start with a template or build your own graph.
- **Run Claude and Codex.** Give each agent its instructions and permissions, then review the request before it starts.
- **Review code before applying it.** Coding attempts run in separate Git worktrees. Inspect their diffs and explicitly approve changes before bringing them into your checkout.
- **Keep track of what happened.** View streamed output, approvals, attempts, and saved run history. Replay a past run without executing it again.

You can browse and edit any existing folder. Running a workflow requires opening the root of a Git repository with at least one commit.

## Run from source

You'll need **Node.js 24 or later**, **pnpm 11**, and **Git**. The desktop app also needs **Rust/Cargo** and the native build tools for your platform. On macOS, install Xcode Command Line Tools.

```sh
git clone https://github.com/asoncode/Nodal_IDE.git
cd Nodal_IDE
pnpm install
pnpm desktop
```

This starts the desktop app in development mode. You don't need a provider account to edit files or run local command workflows.

To run the browser version instead:

```sh
pnpm dev
```

Open the full URL printed in the terminal. It includes a temporary connection token that the app removes from the address bar after connecting. Keep that URL private and reopen it if you reload the browser. Run either browser or desktop development mode at a time; both use port 5173.

## Open a folder and start editing

In the desktop app, choose **File → Open Folder…**, then select a folder. Click a file in Explorer to open it and choose **File → Save** when you're ready to save.

| Action | macOS | Windows / Linux shortcut |
| --- | --- | --- |
| Open folder | `⌘O` | `Ctrl+O` |
| Save | `⌘S` | `Ctrl+S` |
| New window | `⌘⇧N` | `Ctrl+Shift+N` |

Each new window starts with an empty workspace and has its own folder and editor tabs. Nodal asks before discarding unsaved file or workflow edits when you switch folders or close a window. In browser mode, the Explorer folder button lets you enter a full local path.

File saves check whether the file has changed on disk since you opened it. If another editor changes it, Nodal lets you compare the versions rather than silently overwriting the changes.

## Try a workflow without an AI account

Create the included example project:

```sh
pnpm example
```

This creates `.nodal/example-project`, a small Git repository with two intentionally failing tests. It won't overwrite an existing directory.

1. Open that folder in Nodal.
2. Choose **Workflows** in the activity bar, then select **Local command**.
3. Inspect the command node, save the workflow, and run it.
4. Open **Approvals**, review the command, and approve it.
5. Check the real process output in the panel's **Console** tab.

You can also open `add.js`, fix the subtraction, and save it. The **Source control** view shows your edit. Workflow attempts start from committed files, so commit any manual changes you want the next run to use.

For an automated example that runs real tests and retries after a failure:

```sh
pnpm demo:quality-loop
```

This demo uses a deterministic command fixture, not an AI provider, so it doesn't consume model usage.

## Connect Claude or Codex

Sign in through the provider's official CLI, then check whether Nodal can use it:

```sh
codex login
claude auth login
pnpm verify:provider codex
pnpm verify:provider claude
```

You only need to sign in to the providers you plan to use. Nodal doesn't collect your password or store provider credentials in its database. A successful login doesn't guarantee model access or available usage. See [Provider setup](docs/PROVIDERS.md) for details and optional live checks.

The **Feature Builder**, **Parallel Fullstack**, and **Bug Hunt** templates include agent nodes. Set their instructions, choose a model if needed, and review their permissions before running. The **Generate** feature can also use Claude to propose a workflow; you review the preview before applying it.

## How runs affect your code

A workflow runs from a committed snapshot of your repository. Coding attempts use isolated Git worktrees, so unsaved editor buffers and uncommitted changes in your main checkout aren't part of the run.

Commands and provider requests require approval. You can inspect output and diffs as the run progresses, pause new work, or stop the run. Stopping preserves worktrees for inspection. To bring a completed result into your checkout, review its diff and choose **Apply reviewed changes**. Nodal checks for a clean destination and aborts on a merge conflict.

Approved commands run with your operating-system user permissions. Nodal is meant for trusted local code; it does not provide a hardened sandbox for untrusted programs.

Run history is stored locally in `~/.local/share/nodal`. Set `NODAL_DATA_DIR` to use another directory. This data can include prompts, code, and command output, so treat it as private project data. The [Operator guide](docs/OPERATOR_GUIDE.md) covers recovery, worktrees, backups, and troubleshooting.

## Build the desktop app

```sh
pnpm desktop:build
```

On macOS, the app is written to:

```text
apps/desktop/src-tauri/target/release/bundle/macos/Nodal.app
```

You can open this app directly. It bundles Node and the provider SDK dependencies, so the verified Apple Silicon build is about 745 MiB. It's currently an unsigned local build. There are no published installers or automatic updates, and Windows/Linux builds haven't been verified. Native menu and folder-picker interaction still needs manual testing; the shared renderer has automated browser coverage.

For development launch issues, see the [Operator guide](docs/OPERATOR_GUIDE.md). Release builds use their bundled Node executable.

## Development

The app uses React, React Flow, and Monaco inside a Tauri desktop shell. A local Node service runs workflows and stores their history in SQLite.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:bundle
pnpm test:e2e
```

The browser E2E check uses the gstack browse CLI. Install it or set `NODAL_BROWSE_BIN` to its executable. Full coverage and live-provider verification instructions are in [Testing](docs/TESTING.md).

- [Architecture](docs/ARCHITECTURE.md) — processes, packages, scheduling, and persistence.
- [Provider setup](docs/PROVIDERS.md) — authentication, permissions, and SDK behavior.
- [Operator guide](docs/OPERATOR_GUIDE.md) — using and troubleshooting the app.
- [Known limitations](KNOWN_LIMITATIONS.md) — what's partial or still missing.

Source code lives in `apps/desktop` and `packages/{shared,core,runtime,persistence,workspace,providers}`. The original build specification is kept in `FORGE_CODEX_BUILD_SPEC.md` as a historical reference; the application is named Nodal.
