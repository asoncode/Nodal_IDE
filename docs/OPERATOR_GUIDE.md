# Operator guide

## Permissions and approvals

Read the executable, individual arguments, worktree scope, provider/model, and instructions before approval. Graph JSON is untrusted data; it cannot grant itself host privileges. Command nodes always ask authorization per attempt. An approval for one attempt does not authorize a retry or another run.

Use Stop to terminate active sessions and prevent further scheduling. Pause only stops scheduling at safe boundaries; active work can finish and approvals can remain pending. Worktree changes are preserved.

## Repositories and worktrees

Use **File → Open Folder…** in the desktop app to select any existing folder. **File → New Window** opens an independent empty workspace; windows share durable project and run history. Opening another folder or closing a window asks before discarding unsaved file or workflow edits. Browser mode uses the Explorer folder button and a full path instead of the native picker.

For workflows, open the exact Git repository root and ensure it has an initial commit. Ordinary folders can still be browsed and edited without initializing Git. Each attempt starts from captured committed content. Nodal keeps main-working-tree edits separate and refuses to integrate into a dirty destination. Review/commit or stash your changes using your normal Git tools before integration.

Each attempt's node inspector contains its worktree path and source commit. Use a separate editor or Git tools at that path when resolving conflicts. Conflicted automatic integration is aborted and both branches remain. No remote push is performed.

To discard preserved work later, stop Nodal, inspect `git worktree list`, and use Git's normal explicit worktree removal and branch cleanup commands yourself. The app intentionally has no automatic destructive cleanup.

## Crash/restart

The local journal uses SQLite WAL. On startup, unfinished runs and active attempts become interrupted; they cannot be marked successful by inference. Pending approval records remain readable. Inspect preserved worktrees and outputs before using **Re-run as new run**. That action repeats the recorded graph against current committed HEAD and asks fresh permissions. Individual checkpoint resume is not available.

Do not delete the SQLite WAL/SHM files while the app is running. Back up the data directory while stopped. Keep its contents private because prompts, code diffs, and outputs can contain confidential material.

## Troubleshooting

| Symptom | Action |
|---|---|
| Browser says no runtime connection | Launch `pnpm dev`, open the exact printed fragment URL, and keep the process running. Reloading after token removal requires that URL again. |
| Port 5173 is occupied | Stop the other Nodal development process before starting desktop mode. E2E uses port 5174. |
| Native development cannot find Node | Set `NODAL_NODE` to the absolute Node 24+ executable. Release builds include Node. |
| `node:sqlite` is unavailable | Use Node 24 or later and rebuild with `pnpm build`. Do not replace the built-in module with an npm package named sqlite. |
| Provider is installed but unavailable | Run `pnpm install` with optional native dependencies, then `pnpm verify:provider <provider>`. |
| Provider is authenticated but run fails | Inspect the real provider error. Login does not prove entitlement, credit, rate-limit capacity, or model access. |
| Codex refuses MCP configuration | The adapter could not safely disable discovered MCP servers. Use a supported official CLI configuration; no model turn was started. |
| Claude cannot search files | Native recursive tools are deliberately disabled. It receives a path manifest and can read approved files. |
| File save conflict | Your original buffer stays intact. Compare with the disk version or reload explicitly; never retry with an invented hash. |
| File list excludes a path | Git metadata, symlinks, common build/dependency directories, and files beyond display/size limits are omitted. |
| Merge says branch changed | Refresh the diff and approve the new destination/source commits. |
| Tests fail in a fresh worktree because dependencies are missing | Dependencies and untracked files are not copied. Use your own trusted setup command as an explicitly approved graph node; it may access the network with host permissions. |
| Interrupted run cannot resume | Inspect it and create a new run. Automatic repetition of uncertain side effects is intentionally unsupported. |
| Large native app | The release contains Node plus official provider SDK native dependencies. A smaller audited distribution is future release work. |

## Boundaries

Nodal is intended for a trusted local developer working with trusted code. Normal process execution, provider sandboxes, path checks, and Git worktrees are not a complete adversarial containment system. Use an independently hardened container/microVM setup for untrusted code. See the full [limitations](../KNOWN_LIMITATIONS.md).
