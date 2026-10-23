# Nodal

Nodal is a desktop coding workspace where you can edit files and build visual workflows for Claude and Codex. Open a folder, work in the editor, and connect agents, commands, tests, and approval steps on a canvas. You can follow each run as it happens, review the changes, and decide what to apply to your project.

It's an early, working version. The core editing and workflow features are in place, and the desktop app has been built on Apple Silicon macOS. Some editor features and release packaging are still unfinished; see [Known limitations](KNOWN_LIMITATIONS.md).

![Nodal showing a workflow and its execution history](docs/screenshots/nodal.png)

## What you can do

- **Open and edit local folders.** Browse files in Explorer, edit them with Monaco, and save changes to disk. The desktop app includes a native folder picker and separate workspace windows.
- **Use an integrated terminal.** Run your local shell in the open folder, with separate terminal tabs and interactive command output.
- **Build workflows visually.** Add agents, commands, conditions, parallel branches, test checks, bounded retry loops, and human approvals. Start with a template or build your own graph.
- **Chat with Claude or Codex.** Open the chat sidebar for a repository conversation, or start a separate chat using a workflow agent’s context.
- **Run Claude and Codex.** Give each agent its instructions and permissions, then review the request before it starts.
- **Give agents specialist roles.** Configure expertise, reference files, owned paths, skills, and named handoffs. Save roles in the project library and reuse them without changing existing workflows.
- **Give each specialist its own workflow.** A role node contains a playbook, such as orient, plan, implement, test, and self-review. Double-click it to open and edit that inner workflow.
- **Use deterministic steps.** Search code, list or read files, check Git history, find affected tests, or validate a contract without a model call or an approval prompt.
- **Improve workflows over time.** The workflow orchestrator pauses runs that keep failing the same way, summarizes each run, and proposes measured changes that you approve.
- **Reuse workflows across projects.** Save workflows, roles, and lessons to a library folder, then apply them to another project with its own folders and test command.
- **Review code before applying it.** Coding attempts run in separate Git worktrees. Inspect their diffs and explicitly approve changes before bringing them into your checkout.
- **Keep track of what happened.** View streamed output, approvals, attempts, and saved run history. Replay a past run without executing it again.

You can browse and edit any existing folder. Running a workflow requires opening the root of a Git repository with at least one commit.

## Plan a specialist team

Open **Generate**, describe the project, and select its brief files under **Project brief files**. Team planning is on by default. Nodal sends the selected briefs, a bounded file manifest, and your saved project roles to Claude to propose a team. Review or edit its roles, owned paths, handoffs, providers, and models before choosing **Approve team and generate workflow**. The next preview shows the graph; **Apply to canvas** changes the draft without starting a run.

Each agent can use Claude or Codex and its own model. The planning request currently uses Claude because its adapter supports a tool-free planning turn. You can also configure roles in an agent's inspector, save them to the project library, or open **Team** to check file ownership. Library changes do not alter existing steps or active runs.

During a run, Claude checks owned paths before edits; both adapters check the final changes before publishing an attempt. Required handoff files must exist and pass their declared JSON schema. Consumers receive verified handoffs, and replay records supplied context and available usage. These checks supplement provider permissions and do not create an operating-system sandbox.

The **Specialist Team** template demonstrates contracts, parallel specialists, separate test gates, integration, independent review, and human approval. **Specialist Team with playbooks** goes further: each specialist is a role node with its own playbook, the architect records design decisions, and integration failures go back to the specialist that owns the failing files. Adapt both templates' paths and Node test commands to your repository before running them.

### How specialists work together

- **Playbooks.** A role node runs its playbook as part of the run. Its steps work as the role, and everything the playbook changes, including changes made by its commands, must stay within the role's owned paths before its work is published.
- **Tool steps.** Add a Tool step to search code, find symbols, list or read files, read Git history, find tests affected by a change, validate a file against a JSON schema, or read an earlier step's full output. Tools read the step's commit, so the same inputs always give the same result, and results are cached.
- **Owner routing.** Set a quality gate to send failures to the roles that own the failing files. Connect a loop from the gate to each specialist and choose a fallback for failures no file path explains.
- **Consults.** A role can ask another role a question by ending its reply with a consult block. The answer is read-only, needs approval like any provider request, and at most two are allowed per step.
- **Verified facts.** Each role's prompt includes the ownership map, verified contracts, latest test results, recorded decisions, and an index of the code in its area. These facts come from the run, never from model summaries.

### Improve a workflow

Open **Workflow orchestrator** in the activity bar. During a run it pauses when a looping gate fails twice with the same evidence or the run nears its attempt limit, and it writes a summary when the run ends. After at least two runs of a saved workflow, it shows each step's attempts, failures, timeouts, and cost, and proposes specific changes with their evidence. **Apply as new revision** saves the change; later runs compare before and after, and **Revert** restores the previous revision. Lessons you add under **Project memory** are sent to the planner and every role.

### Reuse a workflow in another project

Open **Library**, choose the folder to use, and save the current workflow. Choose which folders and test commands become parameters. In another project, select the item, check the detected values, preview it, and apply it to the canvas. Nodal records which version you imported and offers newer versions as previewed updates. Library items are untrusted: they are validated, never run on import, and their commands still ask for approval. See [Known limitations](KNOWN_LIMITATIONS.md).

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

To create a file, click **New File** in the Explorer header, enter a name such as `script.py`, `main.cpp`, or `notes.md`, and press **Enter**. Nodal creates the empty file and opens it in the editor, choosing syntax highlighting from its extension. You can also enter a path such as `src/main.cpp` inside an existing folder. Existing files are never overwritten; press **Escape** to cancel.

Use **New Folder** to create an empty folder. Select a folder first to create the next file or folder inside it; click the project name to return to the root. The **…** button on each file offers **Rename file**, **Duplicate saved file**, **Delete file**, and copy-path actions. **F2** and **Delete** work when a file row has focus. Rename preserves unsaved editor text. Duplicate copies the saved version on disk.

Deletion moves the saved file into Nodal's own project-scoped trash after confirmation. Click **Deleted files** beside the Explorer filter to restore it, including after restarting the app. Restore refuses to overwrite an existing path. File operations support ordinary text files up to 2 MiB; recursive folder deletion and folder rename are not included.

| Action | macOS | Windows / Linux shortcut |
| --- | --- | --- |
| Open folder | `⌘O` | `Ctrl+O` |
| Save | `⌘S` | `Ctrl+S` |
| New window | `⌘⇧N` | `Ctrl+Shift+N` |
| New file | `⌘N` | `Ctrl+N` |
| Save all open files | `⌘⇧S` | `Ctrl+Shift+S` |
| Quick Open | `⌘P` | `Ctrl+P` |
| Command Palette | `⌘⇧P` | `Ctrl+Shift+P` |
| Find in files | `⌘⇧F` | `Ctrl+Shift+F` |
| Reopen closed editor | `⌘⇧T` | `Ctrl+Shift+T` |
| Toggle word wrap | `Option+Z` | `Alt+Z` |

Each new window starts with an empty workspace and has its own folder and editor tabs. Nodal asks before discarding unsaved file or workflow edits when you switch folders or close a window. In browser mode, the Explorer folder button lets you enter a full local path.

File saves check whether the file has changed on disk since you opened it. If another editor changes it, Nodal lets you compare the versions rather than silently overwriting the changes.

## Find and edit code

Use **Search** in the activity bar to find literal text across saved project files. Match-case and whole-word controls narrow the results; click a match to open its file at that line. Searches skip binary files, linked paths, generated folders, and credential-like filenames, with limits on scanned files, bytes, and matches. Unsaved buffers are not searched.

**Quick Open** finds files by name or path. The **Command Palette** exposes workspace actions and editing commands; use arrow keys and Enter to select one. **Cmd/Ctrl+K** still opens the workflow node picker when the code editor does not have focus.

The editor toolbar provides Find, Replace, Format, Go to Line, word wrap, and preferences for font size, indentation, and the minimap. Preferences are saved on this computer. Monaco also supplies multiple cursors, line comments, folding, and standard editing shortcuts. Formatting and diagnostics depend on its bundled language support; Nodal does not yet connect external language servers. The **Problems** tab lists diagnostics reported for open editors and lets you jump to the relevant line.

Use **Save All**, **Close other editors**, or **Close all editors** from the editor toolbar or Command Palette. Closing dirty editors asks before discarding changes. Manual file saves remain the default; unsaved text and terminal sessions are not restored after quitting. See the [IDE feature comparison](docs/IDE_FEATURES.md) for the implemented baseline and remaining work.

## Use the terminal

Open the bottom panel's **Terminal** tab or press <kbd>Ctrl + `</kbd>. Click **New terminal** or **+** to start your local login shell in the project folder. Each **+** opens another terminal tab. Type commands normally and use **Ctrl+C** to interrupt a foreground command. **Clear terminal** clears the visible terminal history; the **trash** button stops and closes the selected session. Drag the bottom panel sash to resize it; terminal rows and columns follow the available space.

Hiding the panel or switching tabs keeps shells running. Switching or closing the folder, or closing its window, stops that window's terminal sessions. These are ordinary host shells with your user permissions and filesystem/network access. Terminal output is raw, unredacted, and held only in memory; it is not saved with workflow or chat history and is not restored after restart.

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

Open **Generate** to check your Claude/Codex CLI account status in the [generation dialog](docs/screenshots/generation.png). Nodal reuses existing official CLI logins; there is no separate Nodal account connection. If sign-in is missing, run the displayed bundled-CLI login command in Terminal, complete the official sign-in flow, then click **Refresh**.

Preview generation runs in the background with progress and cancellation; closing its dialog cancels an unfinished preview and preserves your prompt.

## Chat with an agent

Click the **Agent chat** speech-bubble icon in the activity bar or top toolbar. Choose Claude or Codex, an optional model, and an access level, then type your message and click **Send & approve**. Each send approves one provider turn using the access shown in the sidebar. Nodal uses your existing official CLI login.

**Read only** chats can inspect the open folder. **Isolated edits** chats work in a separate Git worktree based on committed files; unsaved buffers and uncommitted main-checkout edits aren't copied there. Claude asks for approval before each shell command. Codex may run sandboxed commands as part of the approved turn, with network access disabled. Claude's approved shell commands run with your host user privileges and aren't an OS sandbox.

To discuss a workflow agent, select its node and click **Chat with this agent**, or choose it in the chat's **Context** menu. The conversation uses a snapshot of that node's instructions and model, plus recorded run facts when attached. It is a separate conversation and does not take over or alter the running agent.

Type **@** in the message box to search saved files in the open folder. Use the arrow keys and Enter, or click a result, to attach a file. The **@** button opens the same picker. Use the **paperclip** to upload code or text files from anywhere on your computer. You can remove attachments before sending and expand them in the conversation afterward.

Attachments support UTF-8 text and code: up to 8 files, 64 KiB each, and 256 KiB total per message. References capture saved file contents when you send; unsaved editor changes aren't included. Uploads are context only and aren't copied into your repository or chat worktree. Images, PDFs, and other binary documents aren't supported yet.

Conversations and their activity are saved locally. Select one from **Conversation** to continue it, or use **New chat** to start another. **Stop** cancels active work and preserves partial edits. In editing chats, use **Review changes** and then **Apply reviewed changes** to bring reviewed code into a clean main checkout. Changes are never applied automatically.

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

You can open this app directly. It bundles Node, the provider SDK dependencies, and the native terminal module, so the verified Apple Silicon build is about 807 MiB. It's currently an unsigned local build. There are no published installers or automatic updates, and Windows/Linux builds haven't been verified. Native menu and folder-picker interaction still needs manual testing; the shared renderer has automated browser coverage.

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

Source code lives in `apps/desktop` and `packages/{shared,core,runtime,persistence,workspace,providers}`. The build specification is `FORGE_CODEX_BUILD_SPEC.md`, including the design for specialized agent teams in section 5A. "Forge" in that document refers to Nodal.
