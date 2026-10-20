# FORGE — Codex Implementation Specification

> **Instruction to coding agent:** Build the actual application described below. This is an implementation brief, not a request for a mockup, architecture essay, or landing page. Work in the current repository. Create working files, tests, and runnable instructions. Do not add AI-assistant attribution, watermarks, or statements claiming who generated the code in source files, documentation, commits, or UI.

## 0. Product definition

**Forge** is a local-first, graph-native desktop IDE for orchestrating coding agents. Users visually construct directed workflows of Claude Code agents, OpenAI Codex agents, test/command runners, human approvals, decision gates, and bounded feedback loops. Users can also ask an AI to draft a graph. Each agent works against a real local software repository, with source editing, terminal output, live execution traces, diff review, and checkpoints inside the app.

**Not:** a Cursor clone, chatbot wrapper, fake agent activity animation, or simple Langflow imitation. The core product is a real workflow runtime with auditable state transitions and a first-class code workspace.

**Tagline:** *Build with agents. See every decision.*

### Product principles
1. Graph is primary: workflows are edited visually and executed faithfully.
2. Local first: files, graphs, state, and history remain on the user's computer by default; only explicit provider requests send data out.
3. Human control: stop, pause, approval, diff inspection, and manual edits are accessible throughout.
4. Real integrations: actual provider SDKs or documented runtime adapters, never simulated agent runs presented as real.
5. Reproducibility: every node run has recorded inputs, configuration, artifacts, outputs, and result status.
6. Safety: least privilege by default; no unrestricted shell or broad filesystem/network access without explicit permission.
7. Honest UX: distinguish passed checks from model opinions; expose unverified outcomes and provider limitations.

## 1. Deliverables

Provide a complete source-controlled monorepo containing:
- A bootable desktop app on macOS (primary development target), with reasonable Windows/Linux portability.
- Working interactive graph editor and side-panel node configuration.
- Functional local workflow executor (including branching, parallel fanout, bounded loops, cancellation, pause/resume checkpoints).
- Actual Codex and Claude Agent SDK adapter modules, with clear availability/authentication checks, streamed events, and correct failure states.
- Repo explorer, editable Monaco files, diff viewer, and integrated terminal/command output.
- Git worktree based isolation for parallel coding nodes and explicit merge/reconciliation flow.
- Local durable persistence for graph documents, workflows, runs, node events, and artifacts.
- Natural-language graph generation/editing with schema validation and preview before apply.
- Example workflow templates and a first-run experience.
- Automated unit/integration/E2E tests and concise setup/usage/troubleshooting documentation.

If one feature cannot be implemented fully, implement a real, clearly labeled vertical slice, document the limitation in `KNOWN_LIMITATIONS.md`, and continue toward the next end-to-end testable milestone. Do not silently replace integrations with hard-coded fake responses.

## 2. Proposed stack (deviate only with written architectural rationale)

- **Desktop:** Tauri 2 with Rust shell and strict capabilities.
- **Frontend:** React + TypeScript + Vite, Tailwind CSS, shadcn/ui (or comparable accessible primitives), Lucide icons.
- **Graph UI:** `@xyflow/react` / React Flow.
- **Code editor:** `monaco-editor` with a React wrapper.
- **Backend/runtime:** Node.js TypeScript sidecar, running locally and managed by Tauri; use WebSocket or typed IPC for events. The sidecar must not bind publicly; prefer a secured local IPC transport. If localhost HTTP/WebSocket is required, bind `127.0.0.1`, use a per-launch random auth token, Origin checking, and strict request validation.
- **Storage:** SQLite with migrations and WAL enabled; drizzle or equivalent typed queries.
- **Validation:** Zod + typed shared protocol.
- **Version control:** local Git CLI wrapped by a safe argument-array process runner (never interpolate arbitrary shell strings).
- **Providers:** `@openai/codex-sdk` and `@anthropic-ai/claude-agent-sdk`, using current documented APIs checked during implementation. Detect installed binaries and supported authentication without assuming subscriptions imply API credits.
- **Tests:** Vitest, React Testing Library, Playwright or Tauri-compatible UI smoke tests, plus temporary-Git-repo integration fixtures.
- **Logging:** structured local logs, with redaction of secrets and credentials.

### Suggested monorepo layout

```text
forge/
  apps/desktop/              # Tauri + React UI
    src/components/graph/
    src/components/editor/
    src/components/inspector/
    src/components/runs/
    src/components/layout/
    src-tauri/
  packages/core/             # graph schema, scheduler, state machine, event types
  packages/runtime/          # sidecar service, durable orchestration
  packages/providers/        # Claude, Codex, mock provider (tests only)
  packages/workspace/        # repo access, git worktrees, edits, diff + merge
  packages/persistence/      # SQLite schema, migrations, repositories
  packages/shared/           # shared TypeScript types, Zod schemas
  examples/                  # runnable sample repositories and graph templates
  docs/
  scripts/
  package.json
  README.md
  KNOWN_LIMITATIONS.md
```

## 3. Visual experience

Build a distinctive, usable desktop product, not a dashboard template. Name in UI: **FORGE**. Dark mode first, with neutral charcoal/slate surfaces, restrained teal for active/healthy execution, amber for awaiting approval/retry, red for failed, and subdued grid canvas. Strong typography and spacing. No excessive gradients or gratuitous animations.

### Application layout
- **Left sidebar (collapsible):** current project/repo selector, file explorer, saved graphs, templates, recent runs, provider connection status.
- **Main center (switchable tabs):** Graph Canvas | Code Editor | Diffs | Run Replay.
- **Right inspector:** selected node name, type, provider/model, instructions, tools/permissions, workspace scope, input/output mapping, retry policy, timeout, concurrency priority; graph metadata when none selected.
- **Bottom dock (resizable):** streaming execution timeline, node console, terminal, tests, diagnostics, approval inbox.
- **Top command bar:** project name, graph version, Run, Pause, Stop, Validate, Save, AI Generate, budget/usage summary.

### Graph editor requirements
- Add nodes by toolbar, searchable command palette, and drag/drop.
- Types: Start, Agent, Command/Test, Condition, Parallel Split, Join, Quality Gate, Human Approval, Merge, End.
- Drag, pan, zoom, multi-select, copy/paste, delete, fit view, mini-map, undo/redo, keyboard shortcuts.
- Typed ports; prevent incompatible edges; visibly distinguish control and artifact edges.
- Show per-node queued/running/succeeded/failed/waiting/skipped/cancelled statuses during execution.
- Animated activity only when real events arrive, never as indefinite fake progress.
- Save/load graph JSON with schema versioning and migrations.
- Editing a running graph creates a draft revision; the current run remains pinned to its original immutable graph snapshot.
- Context menus for duplicate, disable, run from checkpoint where safe, compare previous attempts, view logs/diffs.
- Accessibility: keyboard navigation, focus states, semantic labels, sufficient contrast.

### Editor requirements
- Open and edit real local files in chosen repo; dirty buffer indicators, save, tabs, search, syntax highlighting.
- Detect external agent changes and avoid silently overwriting user's unsaved buffers; show reload/compare conflict options.
- Display current worktree/branch clearly; never confuse an agent branch with main.
- Side-by-side diffs and explicit user approval for integration.
- Terminal access is opt-in, scoped to project, and obeys app permissions; sanitize output and limit log retention.

## 4. Graph execution model — must be real

### Typed graph contract
Implement versioned schemas for `Graph`, `Node`, `Edge`, `Port`, `WorkflowRun`, `NodeAttempt`, `Artifact`, `ExecutionEvent`, `ApprovalRequest`, `RunCheckpoint`.

Indicative shape (refine with Zod discriminated unions):

```ts
type NodeKind =
  | 'start' | 'agent' | 'command' | 'condition' | 'parallel'
  | 'join' | 'quality_gate' | 'approval' | 'merge' | 'end';

type NodeState =
  | 'pending' | 'ready' | 'running' | 'waiting_approval'
  | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

type ExecutionEvent = {
  eventId: string;
  runId: string;
  nodeId?: string;
  attemptId?: string;
  sequence: number;
  timestamp: string;
  kind: string;
  payload: unknown;
};
```

### Engine semantics
- Validate graph before running: exactly one Start; all reachable nodes well typed; required ports connected; no dangling required inputs; bounded cycles only; concurrency/iteration guards enforceable; End reachable from valid paths.
- Ordinary paths form a DAG. Cycles only allowed through explicit **Loop/Quality Gate** edges with named maximum iterations and exit conditions; reject arbitrary graph cycles.
- Scheduler queues runnable nodes only when their upstream data/control dependencies are satisfied.
- Parallel nodes may fan out with a configurable concurrency cap. `Join` supports `all_success`, `all_settled`, and `first_success` modes with documented cancellation behavior.
- Branch decisions evaluate deterministic structured values (e.g. exit code, test count, JSON fields, approval result). Never execute arbitrary JavaScript from a graph definition.
- Every retry is a new `NodeAttempt`, retaining prior attempts and artifacts.
- At-least-once recovery requires idempotency or explicit user confirmation for side-effecting actions. Never claim exactly-once execution without proving it.
- Run cancellation propagates to child provider sessions and spawned processes, with termination escalation and cleanup.
- Persist append-only events and materialized state transitions transactionally. Recover `running` states on restart as `interrupted`, not `succeeded`. Provide resume/retry controls and explain actions requiring user authorization.
- Apply time, token/cost (when provider telemetry makes available), iteration, and total graph budget limits. Unknown provider spending must be marked **unknown**, not zero.
- Pause scheduling at safe boundaries; allow pending approvals to remain durable. Stop should prevent additional nodes from starting.

### Quality / parity loop
Use the term **quality loop** or **parity loop** in UI. It compares actual outputs to explicit acceptance criteria and returns a structured verdict:

```ts
{
  verdict: 'pass' | 'fail' | 'inconclusive',
  checks: [{ id: 'unit-tests', status: 'pass' | 'fail', evidenceArtifactId: '...' }],
  defects: [{ severity: 'high', summary: '...', evidenceArtifactId: '...' }],
  nextInstructions: '...',
  iteration: 2,
  maxIterations: 5
}
```

**Pass** must be grounded in machine-verifiable gates when specified (e.g. tests exit 0, expected files exist). A reviewer agent's opinion may supplement but cannot override a failing required test. On fail, loop through fix agent with concrete evidence; on inconclusive, prompt human intervention or stop per configuration. Explicit maximum iterations prevents runaway loops.

## 5. Agent provider integrations

Implement a clean adapter boundary:

```ts
interface AgentProvider {
  id: string;
  checkAvailability(): Promise<ProviderStatus>;
  listModels?(): Promise<ModelOption[]>;
  start(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resume?(sessionId: string, input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
```

`AgentRunInput` includes task prompt, scoped working directory/worktree, artifact inputs, allowed tools, permission mode, resource/time limits, relevant history, and run correlation IDs. `AgentEvent` supports messages, tool request/result, file diff, terminal output, session metadata, usage, warning, and final result. Do not expose private hidden chain-of-thought; show only provider-supplied allowed summaries, actions, tool calls, and output.

### Codex
- Integrate current official `@openai/codex-sdk` with streamed turn events.
- Use documented thread/session APIs and set working directory/approval restrictions properly.
- Check availability and authentication on startup; show actionable errors, not fake "connected" badges.
- Never assume API billing is equivalent to logged-in account/CLI entitlements.

### Claude
- Integrate `@anthropic-ai/claude-agent-sdk` with streamed messages/tool events.
- Use documented project cwd/tool and permission options.
- Check availability/authentication and show provider-specific setup guidance.
- Do not hard-code model names; expose supported configured models, with a usable default from the SDK when available.

### Mock provider
- Deterministic fake provider only for automated tests and an explicitly labeled **Demo Mode**. Never show demo output as a real provider run.

### Auth/credentials
- Prefer documented official authorization flows and OS credential/keychain support where applicable.
- Never request or store raw passwords, browser cookies, or session tokens by scraping.
- API keys should be stored in OS keychain, not SQLite/plaintext config or renderer localStorage.
- All provider/network requests originate from privileged backend, not webview renderer.
- Mask secrets in logs and exports; show a confirmation before exporting logs that may contain private code.

## 6. Repo/workspace isolation and merges

- User chooses an existing local Git repository, or creates a new project.
- Default coding-agent execution occurs in per-node/per-attempt Git worktrees under an app-managed workspace directory, referencing the selected repository.
- Capture source commit SHA and branch/worktree metadata in each attempt.
- Parallel agents have isolated branches; explicit Merge node combines changes and reports conflicts rather than overwriting files.
- Before applying to user's main working tree, display a diff and require confirmation; protect uncommitted changes.
- Support manual editor changes without silent overwrite. After merge, rerun configured integration tests.
- On cancellation, preserve worktree for inspection by default; cleanup only after explicit discard or safe TTL policy.
- Validate paths against workspace boundaries including symlink traversal. Do not permit agent writing outside approved repo except explicitly configured scratch area.
- Prevent accidental commits of `.env`, credentials, or app-managed secrets. No automatic pushes to remote in MVP.

## 7. Natural-language graph builder

Add an **AI Generate Graph** dialog:
1. User describes goal: e.g. "Architect with Claude, implement API with Codex, generate tests in parallel, run tests, review, retry up to 4 times, ask approval before merge."
2. Selected planning provider generates **structured graph JSON only** against a strict schema and allowed node types.
3. Validate shape, connectivity, cycles, limits, and required configuration.
4. Show preview with diff against current graph, provider assignments, estimated max attempts/concurrency, and permission implications.
5. Only apply when user confirms. Preserve undo history.
6. On invalid output, make bounded schema-correction attempts and show a clear error if still invalid.
7. Support incremental prompt edits: "Add a security review before merge" while preserving unrelated nodes/positions where possible.

Graph generation itself must not execute generated code or spawn agents. Treat all generated graph content as untrusted input; no injected arbitrary commands run without the relevant permission flow.

## 8. Run Inspector and Execution Replay

For every workflow run show:
- Timeline of node starts/ends, provider events, tool calls, errors, retries, approval actions, and exit conditions.
- Per-node inputs (with secret redaction), outputs, prompts/instructions, model/provider, permissions, source commit, changed files, diff, tests, duration, and available usage/cost telemetry.
- A persistent **checkpoint** with graph version, base Git SHA, artifact hashes, previous node outputs, environment metadata, and worktree reference.
- **Replay** = reconstruct the saved view of a historical run without triggering execution.
- **Re-run from here** = explicitly create a *new* run/branch based on a preserved checkpoint (never claim deterministic identical AI output); allow model/provider/prompt overrides, compare metrics and diffs.
- Compare two attempts side by side for observed test outcomes, code changes, duration, and usage when available.

No invented telemetry. If provider does not supply reliable token or spending information, show "unavailable".

## 9. Security and trust boundaries

- Local-first does **not** automatically mean sandboxed. Display that warning clearly.
- Default to read-only agent permissions on connecting a repository; user elevates to scoped edit and command permissions per graph/node.
- Executing arbitrary agent-written code requires explicit approval or an opt-in sandbox policy. For untrusted code, use hardened sandboxing (container or microVM with network restrictions and resource quotas); never describe normal Docker defaults as a fully secure boundary.
- Terminal/command runner must not automatically grant arbitrary network access, package install, sudo, or access to home folders.
- A trusted local developer may opt into a less restrictive mode after being shown the risk; store that choice explicitly.
- Confirmation required for destructive filesystem actions, repo reset/clean, branch deletion, external network side effects, installing dependencies outside sandbox, and publishing/pushing changes.
- Guard against prompt injection in repository files/agent outputs. Tool permissions are enforced by runtime policy, not by prompt text.
- No background listening on externally reachable interfaces. Secure renderer-to-backend communication.
- Prevent path traversal, shell injection, arbitrary graph expression execution, and sensitive log leakage.
- Enforce resource ceilings (wall time, output size, concurrency, disk space, subprocess count where feasible).

## 10. Persistence schema (minimum tables)

- `projects` — id, name, repository_root, created_at, updated_at
- `graphs` — id, project_id, name, schema_version, draft_revision, json, created_at, updated_at
- `graph_revisions` — immutable version snapshots and content hash
- `runs` — id, project_id, graph_revision_id, status, created_at, started_at, finished_at, cancel_reason
- `node_attempts` — id, run_id, node_id, iteration, attempt_index, state, provider, model, worktree_path, started_at, finished_at, error_json
- `events` — id, run_id, attempt_id nullable, monotonic_sequence, kind, payload_json, timestamp
- `artifacts` — id, run_id, attempt_id, kind, path/content_hash, metadata_json, created_at
- `approvals` — id, run_id, node_id, decision, requested_at, resolved_at, scope_json
- `checkpoints` — id, run_id, node_id, graph_revision_hash, repo_sha, artifact_manifest_json, created_at
- `provider_config` — id, provider, nonsecret_settings_json; secrets referenced only via OS keychain handle

Migrations must run on startup with backups or transactional safeguards. Add indexes on run/event/attempt lookup paths. Avoid storing enormous raw streams directly in individual DB rows; spool large logs to artifact files with bounded retention.

## 11. Templates and realistic demo

Ship three editable workflow templates:

**A. Feature Builder**
Start → Architect (Claude) → Implement (Codex) → Run Tests → Quality Gate → [pass: Approval → Merge → End; fail: Implement, max 4 attempts].

**B. Parallel Fullstack**
Start → Plan → Parallel [Frontend Agent | Backend Agent | Test Author] → Join → Merge to integration branch → Integration Tests → Review Agent → Human Approval → End.

**C. Bug Hunt**
Start → Diagnose → Reproduce Failure → Patch → Regression Tests → [retry max 3 or complete].

Include one tiny sample repository (e.g., TypeScript API with a failing test) and an end-to-end walkthrough demonstrating a genuine test-fix loop. Tests should be runnable without paid API access via explicitly marked deterministic test fixtures; real provider functionality separately exercises live SDKs.

## 12. Implementation phases — execute sequentially

**Phase 1 — Foundation**
Initialize monorepo, Tauri shell, frontend layout, shared Zod schemas, local sidecar protocol, SQLite migrations, file/repo picker, starter project, command palette. Ensure app launches and basic tests pass.

**Phase 2 — Graph editor + persistence**
Build rich node/edge editor, inspector, save/load, undo/redo, graph validation, sample templates. Ensure graphs round-trip accurately through persistence.

**Phase 3 — Workflow runtime**
Implement graph scheduler, typed artifacts, deterministic conditions, parallel/join, retries, bounded loops, durable events, cancel/pause, state recovery. Use deterministic mock provider in tests; demonstrate event-driven graph status UI.

**Phase 4 — Actual provider adapters**
Integrate Claude Agent SDK and Codex SDK, streamed status/tool/file events, health checks, permission handling, provider configs. Verify live integration where credentials exist, otherwise provide a reproducible manual verification script and clear blocked-auth status.

**Phase 5 — IDE/worktrees**
Build file explorer, Monaco, dirty-buffer handling, Git worktree isolation, git diffs, conflict detection, scoped command runner, and approval-based merge.

**Phase 6 — Visual graph generation + replay**
Create schema-constrained natural-language graph generator and preview/apply flow; durable run inspector, replay viewer, checkpoint-based re-run and comparison.

**Phase 7 — Hardening/polish**
Failure injection, migration testing, reconnection testing, UI accessibility, packaging, README, architecture docs, operator guide, limitation disclosure, and benchmarks.

Each phase must end in a runnable app state. Do not spend all available implementation effort on styling before runtime works.

## 13. Acceptance tests / definition of done

### Product flows
- [ ] A user can select an existing Git repo, inspect/edit a file in Monaco, save, and see filesystem changes.
- [ ] A user can create/edit/save/reopen a graph without layout or node-config loss.
- [ ] Invalid graphs cannot execute and show actionable validation errors.
- [ ] A valid graph can run an actual command/test node with streamed logs and a real exit status.
- [ ] Two independent nodes execute concurrently; join waits according to chosen semantics.
- [ ] A failed test causes a bounded quality loop with attempt history; success exits; iteration limit stops reliably.
- [ ] Stop cancels active provider sessions/processes; no new nodes start.
- [ ] App crash/restart does not mark interrupted work successful; run state can be inspected and safely recovered.
- [ ] Claude adapter can run a simple authorized task and stream events when configured.
- [ ] Codex adapter can run a simple authorized task and stream events when configured.
- [ ] Parallel agents use distinct worktrees; merge conflict is shown and never silently overwritten.
- [ ] Human approval gates block execution durably, including across restart.
- [ ] Natural-language request produces a valid graph preview; user confirms before graph changes.
- [ ] Replay shows recorded history offline; re-run creates a new run rather than mutating old data.
- [ ] Secrets do not appear in exported logs/SQLite; commands and edits stay within approved boundaries.

### Engineering quality
- [ ] `pnpm install` and documented setup succeed from clean checkout.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- [ ] Scheduler unit tests cover topological readiness, conditional routing, parallel joins, loop termination, idempotency/recovery, cancellation races.
- [ ] Workspace tests cover parallel worktrees, dirty state, traversal/symlinks, merge conflict, cancellation cleanup.
- [ ] Runtime process tests cover timeouts, streamed chunks, bounded logs, nonzero exit, and force stop.
- [ ] UI smoke test covers drag/add/configure/connect/save/run, live state, approval and diff inspection.
- [ ] README includes requirements, first-run instructions, provider authentication options, local data paths, security limitations, and screenshots (captured from real app).
- [ ] No placeholder functionality masquerades as complete.

## 14. Explicit non-goals for MVP

- No hosted cloud backend, billing system, shared multiplayer rooms, mobile app, public plugin marketplace, or remote agent farm.
- No auto-pushing to GitHub, auto-deploying to production, or broad autonomous web access by default.
- No infinite loops or unbounded tasks.
- No attempt to reproduce a full VS Code extension ecosystem.
- No claims of fully secure sandboxing without an appropriate isolation mechanism and review.
- No fake performance numbers, fake provider executions, or invented user testimonials.

## 15. Initial execution instructions to Codex

1. Inspect the existing repository and environment before modifying anything. Preserve existing relevant files.
2. Verify current official SDK docs for `@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`, Tauri v2, and React Flow. Prefer installed/current APIs over guesswork; do not fabricate functions.
3. Write a short `docs/ARCHITECTURE.md` with the concrete IPC model, security boundary, event schema, scheduler state machine, and worktree lifecycle, then implement; do not stop at planning.
4. Implement complete vertical slices, starting with *open repo → edit file → create graph → run command node → stream real event → persist run → inspect result*.
5. Continue through phases in order. After each meaningful change, run relevant tests and fix failures.
6. Keep the app usable after each phase. When resource/time limits prevent completing the whole brief, prioritize a functioning real MVP over broad nonfunctional UI scaffolding; document unimplemented items clearly.
7. At completion, report the implemented capabilities, files changed, commands actually run, test results, remaining gaps, and exact instructions to launch. Do not claim untested behavior is verified.

## 16. Official implementation references

Verify these against current releases before coding:
- Codex TypeScript SDK: https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- Claude Agent SDK: https://github.com/anthropics/claude-agent-sdk-typescript
- Claude Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/overview
- React Flow: https://reactflow.dev/
- Tauri: https://v2.tauri.app/
- Monaco editor: https://microsoft.github.io/monaco-editor/

**Ultimate success criterion:** a real user can graph a Claude/Codex coding workflow, execute it against a local repository with bounded loops and worktree isolation, observe genuine streamed actions, modify code themselves, inspect and approve changes, and revisit a durable run trace—without writing orchestration scripts.
