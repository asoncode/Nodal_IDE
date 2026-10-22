# Everyday IDE features

This pass focuses on the file-management and editing loop used in a local coding workspace. The comparison draws on the official [VS Code interface guide](https://code.visualstudio.com/docs/getstarted/userinterface), [VS Code editing guide](https://code.visualstudio.com/docs/editing/codebasics), and [IntelliJ IDEA editing guide](https://www.jetbrains.com/help/idea/working-with-source-code.html), reviewed on October 21, 2026. These products cover much more than this baseline; Nodal does not claim feature parity.

| Area | Available in Nodal | Remaining work |
| --- | --- | --- |
| Explorer | Create files and empty folders, rename/move individual files, duplicate saved files, recoverable delete/restore, copy relative/absolute paths, refresh, collapse, reveal active file | Recursive directory operations, drag-and-drop moves/imports, multi-selection, OS Finder/Explorer reveal |
| Navigation | Path filtering, keyboard Quick Open, searchable Command Palette, file breadcrumbs, Go to Line, clickable search results | Symbol outline across languages, workspace navigation history, multiple workspace roots |
| Editing | Monaco syntax highlighting, multiple cursors, Find/Replace, line comments, folding, formatting where supported, font/indent/minimap/word-wrap preferences | External language servers, cross-file refactoring, formatter installation/configuration, encoding conversion |
| Tabs and saves | Multiple file tabs, dirty indicators, hash conflicts and comparisons, Save All, Close All/Other Editors, reopen closed file | Split editor groups, pinned/preview tabs, autosave, crash recovery/hot exit |
| Search | Saved-file literal search, match case, whole word, bounded results with line/column navigation | Regular expressions, glob include/exclude UI, reviewed multi-file replacement, search unsaved buffers |
| Diagnostics | Problems reported by the bundled Monaco language services for open editors | Compiler/test-runner diagnostics, project-wide language-server diagnostics |
| Terminal | Real local shells, tabs, resize, Ctrl+C, clear, cleanup on folder/window close | Split terminals, profile picker, session restoration |
| Git | Main-checkout and worktree diffs, approved isolated integration, branch context | Stage/unstage, commit UI, blame/history, conflict editor, Git remote authentication UI |
| AI workflows | Claude/Codex repository chat, file context, isolated edits, approvals, visual graphs, recorded runs | Steering live workflow agents, guaranteed long-lived provider continuation |
| Runtime tooling | Local command nodes, approval gates, retries, quality checks, run history | Interactive debugger/DAP, breakpoints, watch variables, test explorer, task discovery |
| Ecosystem | Native local folder/window shell | VS Code extension compatibility/marketplace, remote SSH, dev containers, collaboration, settings sync |

## File safety and scope

Rename, duplicate, delete, and restore apply to regular text files up to 2 MiB. They reject symlinks, hard links, Git internals, path traversal, stale content hashes, and occupied destinations. Case-only renames on a case-insensitive filesystem require an intermediate different name. Folders can be created and displayed when empty, but cannot be recursively deleted or renamed here. Node path APIs are not a hardened sandbox against an adversarial process concurrently replacing directories.

Nodal Trash stores private copies under the local data directory, outside the opened folder, grouped by project. It persists across restarts. Restoring requires the original parent folder to exist and never overwrites an occupied path. There is no automatic purge or retention policy yet; backups consume local disk space. It is separate from the operating system Trash.

Search is literal and single-line, with a 200-character query limit, a 5,000-entry traversal limit, 2 MiB per file, 32 MiB total scanned content, and at most 250 matches. Partial results are labeled. Generated directories and credential-like paths are omitted. Results reflect saved files, so a dirty buffer may differ from the search preview.

## Validation

Unit and integration checks exercise actual filesystem mutations, expected-hash conflicts, collision protection, executable permissions, trash recovery across runtime restarts, search limits, and late-response handling. Renderer tests exercise dirty-buffer rename/delete safeguards, keyboard pickers, preferences, Monaco command routing, and Save All while switching projects. Browser E2E exercises the user-visible flow with a real local runtime. Native build and packaged-sidecar checks are separate from browser interaction checks; Windows/Linux and native OS menu interaction still require platform validation.
