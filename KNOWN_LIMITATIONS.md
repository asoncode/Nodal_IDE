# Known limitations

Nodal implements a functional local MVP. The following specification items remain partial or incomplete.

## Specialist teams, tools, orchestrator, and library (spec sections 5A–5F)

Phases 8–11 and context economy are implemented. These are their current limits.

**Roles and team planning (8a, 8b)**
- Knowledge sources are repository-relative files, directories, or simple globs (`*`, `**`, `?`). Outside-repository knowledge and its approval flow are not implemented; absolute paths are rejected. Retrieval selects bounded matching files, not semantic search. Skills are inline instruction packs inside roles. Role overrides are edited as snapshots.
- Claude checks role ownership and requires a current file read before overwriting existing files. Codex ownership is checked after execution, including provider-created commits and untracked files. The Codex SDK has no reliable hook to enforce read-before-edit or block every out-of-scope write at tool time; rejected attempts stay in isolated worktrees for inspection. Neither adapter is a hardened sandbox for hostile repository content.
- The two Specialist Team templates use example paths and Node test commands; adapt them to the repository. They are not a project bootstrap.

**Collaboration (8c)**
- Owner routing attributes a failure only through repository file paths in the failing output or review findings (full paths, or file names that are unique in the repository). It does not map stack frames, symbols, or test names to owners. Unattributed failures go to the gate's fallback target.
- Consults happen between turns: a role ends its reply with a consult block, Nodal answers it with a read-only provider turn, and the asking role continues in a fresh provider call in the same worktree. Consults cannot interrupt a provider mid-tool-call. At most two per step; each needs approval like any provider request.
- Decision records are validated against a built-in schema when a handoff named `decisions` declares no schema of its own. The verified-facts ledger contains computed and validated facts only; it does not summarize prose.

**Deterministic steps and role playbooks (Phase 9)**
- Tool steps read Git objects at a pinned commit. `symbols` uses per-language line heuristics, not a compiler or language server. `test-impact` is approximate (test file names and references). `search` with `regex` uses POSIX extended expressions (Git's `-E`), not JavaScript syntax. Very large trees can exceed the 4 MB capture limit and fail rather than return partial listings.
- Playbooks allow start, end, agent, command, tool, condition, and quality_gate steps on one code lineage: no parallel branches, merges, approvals, or nested roles inside a role. Nesting is two levels (team, then role).
- Steps inside a playbook ask for approvals like top-level steps. Pausing the run does not pause a playbook that is already executing; stopping does.

**Context economy (5F)**
- Per-layer context size is recorded in characters, because providers report tokens only for the whole request. Provider-omitted token and cost values stay unknown.
- Session resume on retries is off by default. When enabled, a retry runs in a new worktree based on the previous attempt's commit, so a resumed session's earlier file views may be stale; the prompt tells the agent to re-read files. Resume falls back to a fresh turn on any error.

**Orchestrator (Phase 10)**
- Supervision and proposals are rule-based; no model writes proposals or summaries. Rules cover loop exhaustion, timeouts, flaky tests (failed then passed on the same commit), and repeated ownership violations. Proposals need two runs of the current revision.
- Budget reallocation between roles is not implemented: Nodal has no per-role budgets, and global attempt, time, and iteration limits apply. Escalations pause the run; they do not change it.
- The supervisor observes team-level steps. Steps inside role playbooks are bounded by their own gates and the role's timeout, and are summarized through the role's result.
- Before/after comparison uses success rate and attempts per run; it is evidence, not a statistical test.

**Library (Phase 11)**
- The library holds workflows, roles, and lessons. Skills travel inside roles rather than as separate items.
- Parameters are directories (exact paths and path prefixes) and whole command lines. Prose such as instructions is never rewritten, so a project-specific name inside instructions stays as written. Command values are split on whitespace without a shell; quoting is not interpreted.
- Nodal reads and writes the library folder but does not run Git there; commit, push, and pull it yourself to share. Versions are append-only files; Nodal never edits or deletes existing versions.

New role, team, tool, playbook, routing, consult, orchestrator, and library behavior is verified with mocked providers and real temporary Git repositories. Live paid provider turns are not part of the automated suite. Existing approvals, tests, isolation, and merge checks still run; none of these features authorizes skipping them.

## Execution and recovery

- Restart marks unfinished work interrupted and preserves pending approvals, attempts, worktrees, and events. Resuming an interrupted side-effecting graph from an individual checkpoint is not implemented. The supported recovery action creates a new run from the recorded workflow and asks for permissions again. This avoids silently repeating uncertain side effects.
- Checkpoints contain graph hash, source SHA, output values, artifact IDs/hashes via the artifact table, and worktree references. They do not capture a reproducible OS environment, dependency installation, or a complete provider session snapshot.
- Wall time, concurrency, retry, output, iteration, and total-attempt limits are enforced. General graph-wide token/dollar ceilings, disk quotas, subprocess-count quotas, and worktree TTL cleanup are not implemented. Codex spending is unknown when not supplied. Claude estimated spending remains provider telemetry, not a billing guarantee.
- First-success joins allow other branches to settle instead of cancelling them. Loop regions cannot overlap; arbitrary/nested overlapping cycles are rejected. Disabled nodes currently act as successful no-ops and do not forward a workspace result.
- Built-in graph versions use schema version 1. Future schema migrations and historical graph revision selection are not implemented; immutable revisions are retained in SQLite.

## Providers and trust

- Both SDKs passed genuine read-only streaming turns. A real Codex edit→test→quality→approval→integration workflow and tool-free Claude graph preview also passed. Automated provider tests use explicitly mocked SDK events; complex multi-agent feature building, long-lived resume, cancellation of all SDK-owned grandchildren, and provider upgrades need additional live validation.
- Workflow Claude nodes expose scoped Read, plus Edit/Write for edit permission. Native Glob/Grep, shell, subagents, skills, plugins, and network tools are disabled for those nodes. Editing chats additionally support explicitly approved host shell commands. The runtime supplies a file-path manifest (first 500 files) so a file-only agent can discover source files. It cannot perform native recursive search.
- Claude supports tool-free graph planning with structured output. Codex planning is rejected because the SDK cannot enforce a tool-free turn. Custom Codex tool allowlists are rejected. Its read-only sandbox may have wider native read access than the worktree.
- Codex disables hooks, plugins, multi-agent tools, notifications, discovered MCP servers, extra writable roots, network access, and web search for each run. An unreadable/unrecognized MCP configuration fails closed. This is native provider policy, not a reviewed hardened isolation boundary.
- No app-managed OS keychain UI or API-key provisioning is included. Credentials remain in the official provider login flow. Authentication checks cannot establish plan entitlement, API credits, or future availability.
- Arbitrary approved commands have host user filesystem/network access. There is no hardened untrusted-code sandbox. Windows workflow-command termination is limited to the direct child. POSIX process groups receive SIGTERM then SIGKILL.
- Credential filename filters and redaction are heuristics. Arbitrary embedded secrets or private code cannot be perfectly identified. There is no log-export feature; sharing raw local data requires manual review.

## Workspace and interface

- Chat file references and uploads support UTF-8 code/text only (8 files, 64 KiB per file, 256 KiB per message). Images, PDFs, binary documents, and unsaved editor buffers are not supported. References use saved files from the open folder, including in isolated-edit chats; they do not change the worktree base. Attachment snapshots are retained with local conversation history.
- Sidebar chat supports repository conversations and separate workflow-agent context conversations, not messaging or steering an active workflow attempt. Context is captured when the conversation starts. It does not automatically edit graph JSON or update a node's instructions.
- Chat currently has limits of 40 turns per conversation and 100 conversations per project, with at most 200 retained activity events per chat. There is no chat deletion/export UI. Provider continuation can fail if the official CLI session files are removed; large saved transcripts require a new chat.
- Chat command permissions differ by provider: Claude asks for each shell command in editing chats; Codex commands use the sandbox scope approved for the whole turn. Claude host commands are not sandboxed. Per-command Codex approval and guaranteed termination of all SDK-owned descendants are not implemented.

- The main Git diff is unified text. Side-by-side Monaco comparison is provided for disk-versus-unsaved-buffer conflicts; side-by-side attempt comparison and metrics comparisons are not implemented.
- Explorer supports new files and folders, rename/move of individual files, duplicate, recoverable delete/restore, path copying, refresh, and collapse. Mutations support regular text files up to 2 MiB; binary/large-file operations, recursive folder deletion/rename, drag-and-drop moves, and multi-selection are not included. Case-only rename on a case-insensitive filesystem requires an intermediate name. Nodal Trash is private local app data, separate from OS Trash, with no automatic retention purge.
- Quick Open, the Command Palette, bounded saved-file search, Save All, editor preferences, formatting where supported, and Monaco Problems are available. External language servers, cross-file refactoring, debugger/DAP, test explorer, extension marketplace, remote development, and a full Git staging/commit UI remain separate work. Search does not include unsaved buffers, regex/glob UI, or multi-file replacement. Split editors, autosave, hot exit, and unsaved-buffer restoration are not implemented. See [the feature comparison](docs/IDE_FEATURES.md).
- The workflow Console shows streamed node output; the separate Terminal tab provides interactive host shells. Terminal sessions and raw, unredacted output are ephemeral, with bounded in-memory scrollback and no restore. Split panes and shell-profile selection are not implemented.
- Terminal shells run with normal host user permissions. Closing a folder/window stops its terminal sessions, but intentionally detached daemons may survive. Sessions can expire if the app is frozen beyond the runtime lease; the next terminal action reports expiry and lets you open a fresh shell. Native PTY validation currently covers macOS only.
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
