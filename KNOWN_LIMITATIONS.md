# Known limitations

Nodal implements a functional local MVP. The following specification items remain partial or incomplete.

## Execution and recovery

- Restart marks unfinished work interrupted and preserves pending approvals, attempts, worktrees, and events. Resuming an interrupted side-effecting graph from an individual checkpoint is not implemented. The supported recovery action creates a new run from the recorded workflow and asks for permissions again. This avoids silently repeating uncertain side effects.
- Checkpoints contain graph hash, source SHA, output values, artifact IDs/hashes via the artifact table, and worktree references. They do not capture a reproducible OS environment, dependency installation, or a complete provider session snapshot.
- Wall time, concurrency, retry, output, iteration, and total-attempt limits are enforced. General graph-wide token/dollar ceilings, disk quotas, subprocess-count quotas, and worktree TTL cleanup are not implemented. Codex spending is unknown when not supplied. Claude estimated spending remains provider telemetry, not a billing guarantee.
- First-success joins allow other branches to settle instead of cancelling them. Loop regions cannot overlap; arbitrary/nested overlapping cycles are rejected. Disabled nodes currently act as successful no-ops and do not forward a workspace result.
- Built-in graph versions use schema version 1. Future schema migrations and historical graph revision selection are not implemented; immutable revisions are retained in SQLite.

## Providers and trust

- Both SDKs passed genuine read-only streaming turns. A real Codex edit→test→quality→approval→integration workflow and tool-free Claude graph preview also passed. Automated provider tests use explicitly mocked SDK events; complex multi-agent feature building, long-lived resume, cancellation of all SDK-owned grandchildren, and provider upgrades need additional live validation.
- Claude exposes scoped Read, plus Edit/Write for edit permission. Native Glob/Grep, shell, subagents, skills, plugins, and network tools are disabled. The runtime supplies a file-path manifest (first 500 files) so a file-only agent can discover source files. It cannot perform native recursive search.
- Claude supports tool-free graph planning with structured output. Codex planning is rejected because the SDK cannot enforce a tool-free turn. Custom Codex tool allowlists are rejected. Its read-only sandbox may have wider native read access than the worktree.
- Codex disables hooks, plugins, multi-agent tools, notifications, discovered MCP servers, extra writable roots, network access, and web search for each run. An unreadable/unrecognized MCP configuration fails closed. This is native provider policy, not a reviewed hardened isolation boundary.
- No app-managed OS keychain UI or API-key provisioning is included. Credentials remain in the official provider login flow. Authentication checks cannot establish plan entitlement, API credits, or future availability.
- Arbitrary approved commands have host user filesystem/network access. There is no hardened untrusted-code sandbox. Windows process-tree termination is limited to the direct child. POSIX process groups receive SIGTERM then SIGKILL.
- Credential filename filters and redaction are heuristics. Arbitrary embedded secrets or private code cannot be perfectly identified. There is no log-export feature; sharing raw local data requires manual review.

## Workspace and interface

- The main Git diff is unified text. Side-by-side Monaco comparison is provided for disk-versus-unsaved-buffer conflicts; side-by-side attempt comparison and metrics comparisons are not implemented.
- File tabs, search-by-path, syntax highlighting, hash-conflict protection, and editor search are supported. Creating/renaming/deleting files in the explorer, global content search, and a full language-server/VS Code extension system are not included.
- The integrated console shows genuine streamed node output. A separate interactive PTY/free-form terminal is not implemented; commands run through approved command nodes.
- Graph editing includes node configuration, add/connect, drag/pan/zoom, selection, copy/paste, delete, import/export, undo/redo, and minimap. Full context menus, arbitrary custom typed-port editing, an edge-compatibility guard during every connection gesture, and exhaustive keyboard/screen-reader QA are incomplete. Validation still blocks invalid execution.
- Editing a running graph changes the draft and never changes the run snapshot. Historical replay presents saved events and attempts; the timeline scrubber does not reconstruct every historical canvas state. The renderer retains up to 2,000 fetched events; the database retains the complete bounded node streams.
- Generation preview includes JSON, nodes, assignments, and maximum attempts/concurrency. A dedicated current-versus-generated graph diff view and guaranteed minimal incremental edits are not included.
- The side bar, inspector, and bottom panel resize with pointer-drag sashes only (no keyboard resizing; sizes are not persisted); the full multi-pane layout has not been tested across all screen sizes. The desktop minimum size is 1000×650.
- Any existing folder can be opened for browsing and editing, including through the native File menu. Workflows require a Git repository root with an initial commit. `pnpm example` creates a starter repository; there is no general project-creation wizard.
- Merge nodes reconcile branches into an isolated integration worktree. Applying a selected completed worktree to the main checkout is a separate explicit action. Integration tests after that action must be requested/configured manually. Worktree cleanup requires manual Git maintenance after inspection; Nodal does not delete branches automatically.

## Packaging and validation

- The Apple Silicon macOS shell and packaged sidecar build are verified. Native visual QA depends on macOS Accessibility/Screen Recording permission; those permissions were unavailable to the automation session. Browser UI E2E tests cover the same renderer separately.
- Native bundle signing, notarization, auto-update, DMG/MSI/AppImage installers, Windows/Linux builds, and installer smoke tests are not completed.
- Packaging includes a local Node executable and the full official SDK dependencies, making the app large. The staging step installs exact SDK versions, but a separate reproducible transitive release lock and dependency/license audit remain release work.
- The SQLite schema has transactional initialization, WAL, indexes, and restart tests. There is no data-management UI, retention cleanup, destructive-action audit UI, or migration path from an older shipped version.
- No performance baseline or claimed benchmark number is published. The current production editor chunk is large; lazy-loading Monaco and reducing packaged platform artifacts remain optimizations.
