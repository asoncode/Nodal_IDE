# Verification

## Automated checks

`pnpm lint`, `pnpm typecheck`, and `pnpm test` validate source only; generated bundles, native targets, and staged SDK dependency tests are excluded. The suite currently contains 239 unit/integration/UI cases.

Coverage includes deterministic predicate evaluation, graph validation and templates, topological readiness, skipped branches, parallel concurrency, all join policies, retry readiness races, bounded loops with feedback evidence, iteration limits, cancellation during delayed retries, pause/resume boundaries, node/run timeout, approvals, journal failures, and interruption recovery.

Real temporary-Git-repository integration cases exercise file hashes, traversal/links, dirty protection, parallel worktrees, credential/staged-path commit guards, Git hooks/config isolation, merge conflict rollback, process streaming/nonzero exit/timeout, descendant termination, actual runtime approvals, HTTP authentication/Origin/body validation, persisted event state, and reviewed integration. React Testing Library covers graph configuration/save, undo/redo, invalid graph blocking, file writes, generation preview, run events, and approval decisions.

Folder-opening checks cover ordinary folders without Git initialization, file-path rejection, native picker cancellation, keeping dirty buffers when a switch is declined, empty new windows, native Save using the latest editor state without duplicate keyboard writes, window-close confirmation, and listener cleanup. Native event and dialog tests use explicit Tauri mocks; they do not replace OS menu/picker interaction testing.

File-creation checks cover empty files and extension-based syntax, saving with the returned hash, existing files/directories, concurrent creation, traversal and linked paths, missing parent folders, cancellation, IME input, duplicate submissions, and preserving unsaved buffers or a newly selected workspace. Browser E2E creates `src/main.cpp` through Explorer, confirms it opens automatically, edits it with Monaco, and verifies the exact saved bytes. The bundled-runtime check also exercises file creation and saving.

`pnpm build` compiles the renderer and Node runtime. `pnpm verify:bundle` starts the actual compiled sidecar with a temporary data directory, verifies its private handshake and authenticated desktop-origin API, checks initialized SQLite/templates, opens a real PTY, runs a command, resizes and closes it, then verifies graceful shutdown. Set `NODAL_VERIFY_SIDECAR` to a packaged sidecar directory to run the same checks with its bundled Node executable. This catches bundler and native-module errors that TypeScript source tests cannot detect.

`pnpm demo:quality-loop` runs a genuine two-iteration test-fix loop in disposable worktrees. All provider behavior is explicitly absent: a deterministic command fixture fixes the sample on its second attempt. It asserts failed→succeeded test history, real loop events, and unchanged main-working-tree content.

## Browser E2E

`pnpm test:e2e` builds the app and starts a production preview on `127.0.0.1:5174`, with an isolated runtime and temporary repository. All browser actions use gstack's Playwright-backed browse CLI. Install the gstack browse skill, or set `NODAL_BROWSE_BIN` to its executable. This check does not make model requests; it only checks local provider availability/login.

The flow opens a repository, adds a human-approval node, moves it with the keyboard, reconnects its ports, configures and saves a graph, approves a real Node process, checks streamed output, a second durable human gate, and persisted completion, edits a file through Monaco, checks exact disk bytes, inspects Git diff, replays the recorded run without creating another, and captures `docs/screenshots/nodal.png`. The test fails on browser console errors. Avoid using the shared gstack browser simultaneously during this test.

## Live SDK checks

Both `pnpm verify:provider codex --live .nodal/example-project` and `pnpm verify:provider claude --live .nodal/example-project` passed with genuine streamed SDK events and final marker responses in the development environment. Claude's tool set was empty; Codex ran read-only with network/search and extra integration tools disabled. Each returned the required marker. A genuine Codex workflow also fixed the disposable sample's `add.js` in an isolated worktree, passed real tests and the quality gate, blocked on a human gate, exposed the diff, and integrated only after explicit approval. Reproduce with `pnpm exec tsx scripts/verify-live-workflow.ts --live`.

Live Claude graph generation returned a validated preview without applying or executing it. Reproduce with `pnpm exec tsx scripts/verify-graph-generation.ts --live`. Planner schemas explicitly target JSON Schema draft-7, which the installed Claude SDK requires. Planning has two bounded requests, up to six SDK turns per request, and a five-minute per-request timeout. The planner's PreToolUse policy permits only the SDK's `StructuredOutput` result tool; denying it previously made Claude loop until the timeout.

These checks verify the exercised paths. Long-running reliability, provider cancellation, spending ceilings, and filesystem sandbox guarantees still need separate validation.

Automated provider tests use explicit SDK mocks. No mock status is shown as a real provider connection. Models are not fixed in application code; defaults come from the SDK configuration.

## Native checks

The local Apple Silicon Rust toolchain successfully ran `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`. `pnpm desktop:build` packages the renderer, Rust shell, Node executable, and official SDK dependencies into a macOS `.app`. Native visual inspection could not be completed because the computer-use Accessibility/Screen Recording permissions were pending; browser E2E covers the shared renderer.

There is no published performance baseline and no claim of cross-platform verification. See [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) for the remaining acceptance gaps.

## Chat checks

The chat suite uses explicit provider mocks and real temporary Git repositories. It checks per-turn consent, project ownership, independent node/run context, successful provider continuation, failed-session reset, overlapping sends, exact command approval IDs, cancellation while waiting for approval, restart recovery without replay, worktree isolation, and stale-head integration rejection. Provider policy tests verify Bash is unavailable to ordinary/read-only turns and that editing-chat commands pass through the approval hook.

Sidebar tests cover saved history, provider/model selection from a workflow node, send errors, stopping, IME composition, stale polling responses, and cumulative text replacement. Browser E2E seeds an explicitly labeled completed chat fixture to exercise the actual API and renderer without model usage, checks provider/access controls and draft-only behavior, captures `docs/screenshots/chat.png`, and checks the minimum desktop width.

Attachment checks verify that referenced/uploaded contents reach the provider prompt, saved references remain snapshots after disk changes, uploads don't create repository files, and attachment history persists with redaction. Invalid paths, symlinks, credential-like paths, binary formats, excessive counts, UTF-8 byte sizes, and aggregate limits are rejected before provider execution. Composer tests cover keyboard @ selection, reference removal, upload contents, file-only messages, failed-send preservation, unsupported uploads, email-address handling, and Escape dismissal. Browser E2E selects a real reference, uploads an external text fixture, removes/re-adds it, and checks the Send button remains visible at the minimum desktop size without making a model request.

## Terminal checks

Terminal tests exercise real PTYs and mocked xterm rendering: project/window ownership, explicit shell creation, ordered input with UTF-8 byte limits, cursor-based output, truncation resets, renderer backpressure, resizing, exit status, hidden-tab persistence, owner expiry recovery, late-create cleanup, and closing all sessions. Terminal output remains in memory and bypasses chat/workflow persistence and redaction.

Browser E2E runs commands in the opened folder through a real PTY, checks output and workspace width, interrupts a foreground process with Ctrl+C, switches between two terminal tabs, hides/reopens the panel using Ctrl+backquote, and stops both sessions with trash. It captures `docs/screenshots/terminal.png` and uses no provider requests. Real PTY integration tests also cover foreground/background process cleanup, output retention, resize, normal lease expiry, and preserving jobs across machine sleep.

Native staging loads the staged `node-pty` module with the bundled Node executable and opens, resizes, and closes a shell; packaging fails if that check fails. Manually verify the packaged macOS app's Terminal tab and Ctrl+backquote shortcut, input focus, Ctrl+C, and window-close cleanup. Windows/Linux PTY packaging and native interaction remain unverified.

## Everyday IDE checks

Explorer tests use real temporary files for no-clobber rename and duplicate, stale hashes, linked paths, occupied restore destinations, preserved executable permissions, recoverable trash across restarts, and concurrent source removal during rename. Search tests verify literal Unicode text, case/whole-word behavior, sensitive-path exclusions, empty directories, and entry/byte/match bounds.

UI checks cover dirty-buffer rename, confirmation and recovery for deletion, pending-operation editor protection, late responses after project switches, versioned Explorer commands, keyboard/IME-safe quick pickers, saved preferences, supported Monaco actions, diagnostics, and cursor navigation. A model-aware Monaco mock reproduces the wrapper's same-content path-switch behavior and verifies discarded text cannot return after closing/reopening an editor. Save All has a delayed-first-write/folder-switch regression that prevents old buffers being written to a new project.

Browser E2E exercises actual rename, duplicate, delete, restore, folder creation, content search, file/command navigation, preferences, Find, JSON formatting and saving, and reopening a discarded editor with the same saved text as another tab. The existing workflow, approval, chat attachment, and real PTY checks remain in the same flow.

## Workflow preview transport

Generation starts with a short `startGeneration` request, then the renderer polls the project-scoped `inspectGeneration` endpoint. Tests cover delayed completion, provider preflight, explicit application, missing login guidance, bounded retention/concurrency, cancellation and late replies, dialog unmount, and readable API transport errors. Provider tests verify copyable login commands quote paths safely. These checks use mocked model responses and do not consume provider usage.

A disposable native WKWebView harness with the desktop `tauri://localhost` origin reproduced a response connection closing after approximately 61 seconds while a long generation-style HTTP request remained pending. In the same WebView, short start/poll requests completed a simulated preview after about 71 seconds, beyond the failing request’s cutoff. The harness uses a local fake provider rather than making a paid model request.
