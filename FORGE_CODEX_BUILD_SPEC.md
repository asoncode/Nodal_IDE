# FORGE — Codex Implementation Specification

> **Instruction to coding agent:** Build the actual application described below. This is an implementation brief, not a request for a mockup, architecture essay, or landing page. Work in the current repository. Create working files, tests, and runnable instructions. Do not add AI-assistant attribution, watermarks, or statements claiming who generated the code in source files, documentation, commits, or UI.

## 0. Product definition

**Forge** is a local-first, graph-native desktop IDE for orchestrating coding agents. Users visually construct directed workflows of Claude Code agents, OpenAI Codex agents, test/command runners, human approvals, decision gates, and bounded feedback loops. Users can also ask an AI to draft a graph. Each agent works against a real local software repository, with source editing, terminal output, live execution traces, diff review, and checkpoints inside the app.

> **Naming:** the application ships as **Nodal**. "Forge" in this document refers to the same product.

**The point of the graph is a team, not a pipeline.** A workflow should behave like a software engineering team: specialized agents with distinct roles (for example a researcher, an architect, a spatial-intelligence engineer, a simulation engineer, a UI engineer, an integration engineer, and reviewers), each with its own expertise, reference knowledge, area of ownership in the codebase, and handoffs to the others. The implementation itself must be a graph of collaborating specialists, never one generic "implement everything" node. That team works inside the full engineering lifecycle: research and architecture, shared contracts, testing, quality loops, reviews, human approvals, and integration all remain first-class parts of the graph. See section 5A.

Four supporting ideas complete the model:
- **Deterministic steps (5B):** work that needs no judgment, such as code search, reading files, or git history, runs as built-in tool nodes with no model call.
- **Role subgraphs (5C):** each role can open into its own internal workflow, so the top level reads as a team and each role shows how it works.
- **Orchestrator (5D):** every workflow has one. It supervises runs within strict bounds and, between runs, proposes measured improvements that the user approves, so workflows get better as a project goes on.
- **Library (5E):** workflows, roles, and lessons are saved to a portable folder and reused across projects.
- **Context economy (5F):** cache-friendly prompt layering, a ledger of verified facts, a deterministic index, and handoff digests cut rediscovery without changing what is verified.

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
8. Specialization: work is divided among roles with real expertise, knowledge, ownership, and handoffs. A role is enforced by the runtime, not just named in a prompt.

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
- Types: Start, Agent, Command/Test, Condition, Parallel Split, Join, Quality Gate, Human Approval, Merge, End, Tool (deterministic: search, symbols, read, list, git, test-impact, validate), and Role (composite with an internal graph; open it to drill in).
- Agent nodes display their role (section 5A). Handoffs between roles render as artifact edges so communication paths are visible.
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
  | 'join' | 'quality_gate' | 'approval' | 'merge' | 'end'
  | 'tool'   // deterministic built-in step (section 5B)
  | 'role';  // composite specialist with an internal subgraph (section 5C)

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

## 5A. Specialized agent teams

A workflow is a team of specialists working inside the full engineering lifecycle. This section defines what a role is, how the planner staffs a team, how roles collaborate, and how the team fits with testing, reviews, and approvals.

### Status
Sections 5A–5F are implemented in Nodal: role snapshots and the project role library, team-first planning, verified handoffs, owner-routed failures, consults, decision records, the verified-facts ledger, tool steps, role playbooks, the orchestrator, the library, and context economy. Before this work, agent nodes held only provider, model, instructions, permission, and tools, and generated graphs collapsed implementation into one generic node. Current limits are listed in `KNOWN_LIMITATIONS.md`.

### Role model
Extend the agent node with a `role`, stored in a reusable project role library so a role can appear in many workflows:

| Field | Purpose | Enforcement |
|---|---|---|
| `title` | Role name shown on the node, e.g. "Spatial intelligence engineer". | Display only. |
| `expertise` | Standing brief: who this role is, its standards, what good work looks like, what it must not do. Separate from the per-step task instructions. | Placed first in every prompt for the role. |
| `knowledge` | Reference sources the role always works with: repo files, folders, or globs; approved read-only directories outside the repo (e.g. a reference codebase); and docs. | Injected as an index plus retrieved excerpts within a budget. Paths outside the repo require explicit approval and are read-only. |
| `owns` | Paths or globs this role builds and may edit. | Claude: tool-time path checks. Codex: post-attempt diff check. An edit outside the role's area fails the attempt unless approved. |
| `produces` / `consumes` | Named handoffs: contracts, schemas, decision records, or datasets at repo paths, e.g. `contracts/match-events.schema.json`. | After a step, required outputs must exist and validate where a schema is declared. Consumers receive them as context. |
| `skills` | Optional reusable instruction packs, such as testing conventions, domain playbooks, or style guides. | Injected with the expertise brief. |

Large knowledge must be retrieved, not pasted wholesale. Report the context actually supplied to each attempt in the run inspector.

### Team-first planning
The planner works in two reviewed steps:
1. **Staff the team.** Inputs: the user goal, project brief files the user selects (for example `CAUSAL_XI_Project_Brief.md`), the repository manifest, and the existing role library. Output: proposed roles with expertise, knowledge, ownership, and handoffs, plus an ownership map of the codebase. The user reviews and edits the team before any wiring.
2. **Wire the team into the lifecycle.** Using the approved roles, generate the graph. Specialists build in parallel where their ownership does not overlap, against contracts produced earlier, and every coding role is covered by tests.

Additional validation: ownership of parallel roles must not overlap; every planned area of the codebase has an owner; every consumed handoff is produced upstream; every coding role sits inside a test gate; and no single node is assigned the whole implementation when the team has more than one specialist.

### The full lifecycle stays in the graph
Specialists replace the single "implement" block. They do not replace the rest of the process. A typical generated workflow:

```text
Orchestrator (section 5D): supervises the whole run
Start
  → Research (researcher, read-only): domain notes, prior art, data sources
  → Architecture & contracts (architect): system design, interface contracts, acceptance tests
  → Parallel specialists, each with its own tests and bounded quality loop:
      Spatial intelligence engineer   → unit tests → gate
      Causal / simulation engineer    → unit tests → gate
      Broadcast UI engineer           → component tests → gate
  → Join → Merge
  → Integration engineer → integration + end-to-end tests → gate (failures routed to owners)
  → Specialist reviews (each owner reviews changes touching its area)
  → Independent review → review gate (findings routed to owners)
  → Human approval → Integrate approved work
End
```

Each specialist above is a role node with its own internal playbook (section 5C), mixing deterministic tool steps (section 5B) with agent steps. Tests stay the authority. Model reviews add findings but never override a failing required test.

### Collaboration between roles
- **Contracts first.** The architect writes interface contracts and acceptance tests into the repository before specialists start. Specialists build against them. Changing a contract requires the architect role or human approval, and the change is visible as a diff.
- **Owner-routed failures.** When an integration or review gate fails, map the failing tests, stack-trace paths, and review findings to owners using the ownership map, and send each failure to the role that owns it with the evidence. Fall back to the integration engineer when ownership is ambiguous. Iteration limits apply per route and to the whole run.
- **Consults.** During an attempt, a role may ask another role a bounded, read-only question, answered in the consulted role's context. Consults are recorded in the trace, count against budgets, can never grant edit access, and are capped per attempt.
- **Decision log.** Roles record decisions and assumptions as validated handoff artifacts, each tied to its source step and commit. They appear in the project ledger (section 5F) for later roles, and they are never free-form edits to shared state.

### Making collaboration visible
- Nodes show a role badge and title. The inspector shows the role's expertise, knowledge, ownership, and handoffs, with overrides per step.
- Handoffs appear on the canvas as artifact edges from producer to consumer, so the communication paths are visible, not implied.
- A team view lists roles, the ownership map, and coverage gaps. Run replay shows each consult, handoff, and routed failure.

### Safety and limits
- Ownership and knowledge scopes are runtime policy, never prompt text. A role cannot widen its own scope.
- Consults, routed failures, and loops are bounded; no unbounded agent-to-agent conversation.
- Role knowledge outside the repository is read-only and approved per project.
- Report token, time, and cost telemetry per role where providers supply it. Unknown remains "unknown".

## 5B. Deterministic steps

Not every node needs a model. Any step that does not require judgment runs as a built-in, deterministic **tool node**: same inputs and repository state, same output, no provider call.

| Tool | Output |
|---|---|
| `search` | Text or regex matches across the repository, with paths, lines, and context (ripgrep semantics). |
| `symbols` | Definitions and references for a symbol, from language tooling where available. |
| `read` | File contents or excerpts by path, glob, or line range. |
| `list` | Directory structure and file metadata for paths or globs. |
| `git` | Log, blame, and diff since a ref for given paths. |
| `test-impact` | Tests that cover changed files, from coverage data or naming conventions; marked as approximate when inferred. |
| `validate` | Whether a handoff artifact exists and matches its declared schema. |

Rules:
- Tool nodes are read-only, confined to the workspace (or a role's approved knowledge paths), and run without approval prompts. A Command node remains the way to run arbitrary programs, and it still requires approval.
- Results are structured JSON artifacts with size limits. They are cached by tool, arguments, and repository SHA, and recorded in replay like any other step.
- Results feed agents as context and can drive conditions and gates (for example "no remaining `TODO(contract)` matches").
- Planning rule: use a deterministic step whenever the task does not need judgment. Search before an agent reads; tests before a reviewer's opinion.

## 5C. Role subgraphs

A role (section 5A) can carry its own internal workflow, its **playbook**. The canvas then has two levels:
- **Team level:** roles collaborating through the full lifecycle. Each role appears as one composite node that shows its status and progress.
- **Role level:** opening a role shows its internal graph, built from the same node types, including tool nodes, agents, commands, gates, and loops.

Example playbook for a spatial-intelligence engineer:

```text
search related code (tool) → read knowledge excerpts (tool) → plan (agent, read-only)
  → implement (agent, scoped to owned paths) → unit tests (command) → gate [fail: loop to implement]
  → self-review against contracts (agent) → validate handoff (tool) → publish
```

Execution and validation:
- A role subgraph runs as a scoped child of the parent run. It inherits the parent's code lineage, ownership scope, permissions, and budgets, and can never exceed them.
- It exposes only its declared outputs and handoffs to the team level. Failures bubble up with their evidence.
- Loops inside a playbook are bounded and count toward the run's total limits.
- The validator checks each subgraph and its interface (required inputs, declared outputs). Nesting is limited to two levels (team, then role) until proven necessary.
- Roles ship with default playbooks by role type. Users can customize them, and they are saved with the role (section 5E).
- Replay supports drilling into a role to see its internal steps.

## 5D. Orchestrator

Every workflow has exactly one orchestrator. It is a workflow-level component, not a node the user wires, and it is visible above the canvas and in the inspector. It has two jobs.

**During a run: bounded supervision**
- Tracks progress, budgets, and stalls across roles.
- Routes integration and review failures to owning roles (section 5A), using deterministic signals first (ownership map, failing test paths) and model judgment only when ambiguous.
- Answers or brokers consults between roles.
- Reallocates remaining budget among roles within the run's global limits.
- Pauses and escalates to the human when progress stalls: the same failure repeating, budgets nearly exhausted, or conflicting contracts.
- Writes a run summary: what was built, what failed, and what remains.

It cannot change the structure of a pinned run, widen permissions, skip required tests or approvals, or edit code.

**Between runs: measured self-improvement**
- Computes metrics per role and per step from durable run history: attempts and iterations until tests pass, recurring failure categories, recurring review findings, flaky tests, duration, and cost where providers report it (otherwise "unknown").
- Proposes improvements as reviewable revisions, each with rationale and evidence. Examples: add a contract-test step to a role's playbook, split an overloaded role, add a knowledge source, change a model, tighten instructions, raise or lower an iteration limit.
- Approved proposals become new workflow or role versions. Later runs (or re-runs from checkpoints) compare before and after, and the orchestrator recommends keeping or reverting the change.
- Records lessons (conventions, pitfalls, decisions) in a versioned, user-editable project memory, which the planner and roles receive as context.

Self-improvement is measured, proposed, approved, versioned, and reversible. The orchestrator never modifies a workflow silently.

Cost: the orchestrator runs on deterministic rules by default and calls a model only for summaries, ambiguous routing, and improvement proposals. Its usage counts against run budgets, and a rules-only mode is available.

## 5E. Workflow and role library

Workflows, roles (with their playbooks), skills, and lessons can be saved to a portable library and applied to other projects.

- **Storage:** a folder on disk (default `~/Nodal/Library`, configurable). It can be a Git repository to share with a team. Items are human-readable JSON and Markdown with schema versions. They contain no secrets and no absolute paths.
- **Parameters:** project-specific values become declared parameters, such as `{backendDir}`, `{testCommand}`, or `{language}`. Importing into a project binds them. Nodal detects defaults from the target repository (for example `package.json` or `pyproject.toml`), lists unbound parameters, validates the result, and shows a preview before applying.
- **Versions and provenance:** every item records its version, origin project, and changelog. Projects pin the version they use and can upgrade explicitly. Improvements approved through the orchestrator (section 5D) can be published back to the library, with approval.
- **Trust:** imported items are untrusted input. Commands still require approval, and knowledge paths outside the new project must be re-approved there.

## 5F. Context economy

Goal: fewer wasted tokens on rediscovery and repeated prompts, with no loss of quality. Every technique here must meet one standard: **its worst case is a smaller saving, never a quieter failure.** Context techniques never change what is verified. Tests, gates, approvals, and permissions behave the same with or without them.

### Adopted techniques

**1. Layered prompts for provider caching.** Assemble every agent prompt in a fixed order, from most stable to most volatile:

```text
[platform rules] → [project ledger @ commit] → [role pack: expertise, skills, contracts] → [task] → [new evidence]
```

The content is identical to an unordered prompt; only the order changes. Parallel roles and loop retries then share long identical prefixes, which providers cache and bill at a reduced rate. Never put timestamps, IDs, or other changing values in the stable layers.

**2. Project ledger (verified facts only).** A compact, structured document pinned to a commit SHA. It contains only what Nodal can compute or verify:
- the file list and the deterministic repository index (below)
- the ownership map and contract index from the approved team (section 5A)
- the current test status per suite, from the last recorded results
- decisions recorded through validated handoff artifacts, each with its source step and commit

Agents never edit the ledger directly. Each role receives only its relevant slice. The ledger orients agents and never outranks the code or tests: when they disagree, the code and tests are correct, and the ledger is regenerated.

**3. Deterministic repository index.** Symbols (from language tooling), import and dependency edges, file sizes, and test-to-source mapping, rebuilt incrementally from changed files. Agents query it through tool nodes (section 5B) instead of opening files to get oriented. It contains no model-written content.

**4. Handoff digests in addition to full text.** After each step, record a structured digest: files changed and the diff stats (from Git), interfaces touched, test results, and the step's own short summary of open issues. Downstream steps receive digests for distant ancestors and full text for their direct predecessors, within the context budget. Full outputs always stay retrievable through a tool node.

**5. Diffs for orientation, files for editing.** Downstream steps receive the diff and the symbols it affected, so they know what changed. Before editing a file, an agent still reads its current contents through its normal tools. Summaries and diffs never substitute for reading the code being changed.

**6. Push essentials, pull details.** Each prompt includes the role pack, the ledger slice, the task, and the evidence. Everything else (other files, full prior outputs, search results) is available on demand through tool nodes.

**7. Caching deterministic results.** Tool-node results (section 5B) and index entries are cached by tool, arguments, and commit SHA, and are invalidated when any input changes. Cached results are only ever reused for read-only lookups.

**8. Measure everything.** Record per step: input and output tokens, cached input tokens where the provider reports them, context size by layer, and duration. Show these in run replay and feed them to the orchestrator's metrics (section 5D). Report figures a provider does not supply as "unknown".

**9. Model choice stays explicit.** The planner may suggest a smaller model for a narrow role, but models change only through the user's node configuration or an approved improvement proposal (section 5D).

### Adopted only after measurement
**Session resume on quality-loop retries.** Resuming an agent's previous provider session on a retry, and sending only the new failure evidence, can save the cost of re-establishing context. It stays off by default. Enable it per workflow only after comparison runs show equal or better pass rates. When enabled, cap it at two consecutive resumes before a fresh start with digests, and fall back to a fresh session automatically if resuming fails.

### Deliberately excluded
These save tokens but risk misleading every agent or silently lowering quality:
- **Model-written summaries as shared truth.** A wrong summary misleads every role that reads it. Summaries may appear only as clearly labeled, per-step output, never in the ledger or index.
- **Agents editing shared state freely.** Shared state changes only through verified data or validated handoffs.
- **Automatic compaction or pruning of an agent's context mid-task.** It discards information unpredictably.
- **Automatic model downgrades** to save tokens.
- **Skipping or reusing tests, gates, or approvals because of a cache.** Verification always runs.

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
1. User describes goal: e.g. "Architect with Claude, implement API with Codex, generate tests in parallel, run tests, review, retry up to 4 times, ask approval before merge." The user can attach project brief files, which the planner reads.
2. The planner first proposes the team (section 5A): roles, expertise, knowledge, ownership, and handoffs. The user reviews and edits it.
3. Selected planning provider then generates **structured graph JSON only** against a strict schema and allowed node types, wiring the approved team into the full lifecycle. It prefers deterministic tool steps where no judgment is needed (section 5B), gives each role a playbook (section 5C), and draws on the project memory and library (sections 5D and 5E).
4. Validate shape, connectivity, cycles, limits, required configuration, and the team rules in section 5A (non-overlapping ownership, produced handoffs, test coverage for every coding role).
5. Show preview with diff against current graph, roles and provider assignments, estimated max attempts/concurrency, and permission implications.
6. Only apply when user confirms. Preserve undo history.
7. On invalid output, make bounded schema-correction attempts and show a clear error if still invalid.
8. Support incremental prompt edits, from the Generate dialog or the agent chat: "Add a security review before merge" or "Split the backend role into simulation and API roles" while preserving unrelated nodes/positions where possible.

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
- `roles` — id, project_id, title, expertise, knowledge_json, owns_json, produces_json, consumes_json, skills_json, created_at, updated_at (the project role library)
- `handoffs` — id, run_id, producer_node_id, name, path, content_hash, validated, created_at
- `consults` — id, run_id, attempt_id, from_role_id, to_role_id, question, answer, created_at
- `node_attempts` gains `parent_attempt_id` so role-subgraph attempts nest under their role
- `tool_cache` — tool, args_hash, repo_sha, result_artifact_id, created_at
- `metrics` — run_id, node_id, role_id, attempts, iterations, duration_ms, cost (nullable), failure_category
- `improvement_proposals` — id, project_id, target (workflow or role), base_version, diff_json, rationale, evidence_json, status, decided_at, outcome_json
- `lessons` — id, project_id, text, source_run_id, version, created_at (project memory)
- `library_items` — id, kind (workflow, role, skill, lesson), name, version, origin_project, parameters_json, path
- `context_usage` — attempt_id, layer, tokens, cached_tokens (nullable), created_at
- `repo_index` — repo_sha, path, content_hash, symbols_json, imports_json, tests_json (deterministic only)
- `ledger_snapshots` — id, project_id, repo_sha, content_json, sources_json, created_at

Migrations must run on startup with backups or transactional safeguards. Add indexes on run/event/attempt lookup paths. Avoid storing enormous raw streams directly in individual DB rows; spool large logs to artifact files with bounded retention.

## 11. Templates and realistic demo

Ship four editable workflow templates:

**A. Feature Builder**
Start → Architect (Claude) → Implement (Codex) → Run Tests → Quality Gate → [pass: Approval → Merge → End; fail: Implement, max 4 attempts].

**B. Parallel Fullstack**
Start → Plan → Parallel [Frontend Agent | Backend Agent | Test Author] → Join → Merge to integration branch → Integration Tests → Review Agent → Human Approval → End.

**C. Bug Hunt**
Start → Diagnose → Reproduce Failure → Patch → Regression Tests → [retry max 3 or complete].

**D. Specialist Team**
Start → Research → Architecture & Contracts → Parallel [Specialist A | Specialist B | Specialist C, each with its own tests and quality loop] → Join → Merge → Integration Engineer → Integration Tests → [owner-routed fixes] → Specialist Reviews → Independent Review Gate → Human Approval → Integrate. Ships with example roles that have expertise, knowledge, ownership, and handoffs filled in (section 5A).

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

**Phase 8 — Specialized agent teams (section 5A)**
- 8a. Role model: role library, role fields on agent nodes, prompt assembly from expertise, skills, knowledge, and handoffs; runtime enforcement of ownership and knowledge scopes; role display in nodes and inspector.
- 8b. Team-first planning: planner reads selected brief files, proposes a team for review, then wires it into the full lifecycle; team validation rules; Specialist Team template.
- 8c. Collaboration: contracts-first handoffs with validation, owner-routed failures from integration and review gates, bounded consults, decision log, and replay of consults, handoffs, and routes.

**Phase 9 — Deterministic steps and role subgraphs (sections 5B and 5C)**
Built-in tool nodes with caching and replay; role nodes with internal playbooks, drill-in editing and replay, scoped child execution, interface validation, and default playbooks by role type.

**Phase 10 — Orchestrator (section 5D)**
Run supervision with bounded actions and escalation; per-role metrics; improvement proposals with evidence, approval, versioning, and before/after comparison; project memory.

**Phase 11 — Library (section 5E)**
Save and import workflows, roles, skills, and lessons through a library folder; parameter binding with detected defaults; versions and provenance; publishing approved improvements back.

**Context economy (section 5F)**
Build alongside the phases it touches. Layered prompts and per-step token reporting are low-risk and can ship first; the deterministic index ships with tool nodes (Phase 9), the ledger and handoff digests with team collaboration (Phase 8c), and session resume stays off until comparison runs justify it.

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
- [ ] Given a project brief, the planner proposes a team of specialized roles for review, and the generated graph assigns implementation to those roles rather than one generic node, with tests, reviews, and approvals still present.
- [ ] A role's edits outside its owned paths are blocked or require approval; its knowledge sources appear in its prompt context and in the run inspector.
- [ ] A consumer role receives the handoffs it declares, and a missing required handoff fails the producing step.
- [ ] An integration test failure in a file owned by one role is routed back to that role with the failing evidence, within iteration limits.
- [ ] Consults between roles are bounded, read-only, and visible in replay.
- [ ] A tool node (for example `search`) returns identical results for the same repository SHA without a provider call or approval prompt, and its result is cached and visible in replay.
- [ ] A role node's internal playbook runs as a scoped child of the run, cannot exceed the role's ownership or budget, and is inspectable by drilling in during the run and in replay.
- [ ] Every workflow has an orchestrator. During a run it can route failures and escalate but cannot change the pinned graph, permissions, tests, or approvals.
- [ ] After several runs, the orchestrator proposes an improvement backed by recorded metrics. Applying it creates a new version, and a later run reports the before/after comparison.
- [ ] A workflow saved to the library from one project imports into another with parameters bound, validated, and previewed, and its commands still require approval there.
- [ ] Agent prompts assemble in the fixed layer order. Parallel roles and retries share identical stable prefixes, and replay shows tokens and cached tokens per step (or "unknown").
- [ ] The ledger contains only computed or validated facts, each with its source and commit. Agents cannot write to it, and it is regenerated when it disagrees with the code or tests.
- [ ] With every context technique enabled, the same workflow runs the same tests, gates, and approvals as with all of them disabled.
- [ ] An agent reads a file's current contents before editing it, even when it received a diff or digest for that file.

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
- No silent self-modification: the orchestrator proposes changes, and the user approves them.
- No token-saving technique that can skip verification or present model-written summaries as shared truth (section 5F).
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
