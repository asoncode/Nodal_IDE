# Nodal architecture

Nodal is a local graph editor and workflow runtime. The renderer edits drafts; the
runtime executes an immutable, schema-validated graph snapshot. A graph is never a
JavaScript program: decisions read structured results and apply a small set of
comparison operators.

## Processes and trust

The React renderer communicates with a Node sidecar through authenticated localhost HTTP and
sequence-based event polling (850 ms while viewing a run). The sidecar binds only to `127.0.0.1`, generates a random token
for each launch, requires that token on privileged requests, and checks Origin
against the explicit development and desktop renderer origins. Request bodies
are validated before filesystem, process, or provider operations. Tauri provides
the desktop shell; the same renderer can be used for local development.

Local execution is not an operating-system sandbox. Filesystem access is scoped
to the selected repository and approved worktrees, with canonical path checks
that include symlinks. Commands use argument arrays rather than shell expansion.
Agent permissions start read-only; mutation and command execution require an
explicit runtime permission. Provider credentials belong to the provider's
official authentication flow or OS keychain, never graph JSON or SQLite.

## Packages and protocol

`shared` owns Zod schemas for graph documents, node attempts, artifacts, approval
requests, checkpoints, workflow runs, and append-only execution events. `core`
owns validation, deterministic scheduling, templates, and the runtime state
machine. It injects side effects through an execution callback. `runtime` owns
transport, permission enforcement, durable orchestration, and event delivery.
`workspace` owns files, commands, Git, and worktrees. `providers` translates SDK
streams into public provider events. `persistence` owns SQLite migrations and
queries.

An execution event has an ID, run ID, optional node and attempt IDs, a monotonic
sequence, timestamp, kind, and structured payload. The event sink is awaited
before dependent scheduling. Runtime persistence stores the append-only event
and its materialized state in one SQLite transaction, with WAL enabled.
Provider events contain public messages, actions, usage, and results; private
reasoning is neither requested nor displayed. Missing spending telemetry is
unknown, not zero.

## Graph and scheduler

Nodes are Start, Agent, Command, Condition, Parallel, Join, Quality Gate,
Approval, Merge, and End. Edges distinguish control, artifact, and explicit
quality-loop transitions. Ordinary edges form a DAG. Exactly one Start and at
least one reachable End are required; unreachable nodes, mismatched ports,
arbitrary cycles, invalid loop targets, and unbounded limits are rejected.

Node states are pending, ready, running, waiting_approval, succeeded, failed,
skipped, cancelled, and interrupted. A run moves from queued to running, then
may pause at scheduling boundaries, wait for approval, or finish as succeeded,
failed, cancelled, or interrupted. Pause lets in-flight work settle. Cancel
aborts child signals immediately and prevents further launches. Timeouts abort
the attempt and produce failure, even if a callback subsequently returns.

Dependencies are evaluated from settled upstream nodes. Conditions select
`true` or `false` control ports. Quality gates select `pass`, `fail`, or
`inconclusive`. Nonselected paths become skipped, propagating through ordinary
nodes. Join modes are all_success, all_settled, and first_success. The first
success mode proceeds after one successful selected parent; remaining work is
allowed to settle rather than being silently discarded. A failed command can
feed a quality gate or an all_settled join for explicit handling; otherwise it
blocks dependent work and causes the run to fail.

Quality loops are explicit `loop` edges from a quality gate's `fail` port to a
prior node. A retry resets only nodes on paths from that target to that gate and
retains all attempts and results. Loops cannot overlap. Iteration and total
attempt ceilings bound execution. When a loop exhausts its limit, the gate
fails. Required machine checks cannot be overridden by an agent's opinion.
Each retry receives a fresh attempt ID and abort signal.

## Workspace and recovery

Each coding attempt receives an isolated Git worktree and records its source
commit, branch, and path. Parallel attempts use separate worktrees. A merge
creates an integration result and exposes conflicts. Applying changes to the
user's checkout requires diff review, explicit approval, and protection of dirty
files. Cancellation preserves worktrees for inspection; deletion is explicit.

Checkpoints retain graph revision/hash, repository commit, prior results,
artifact manifest, and workspace references. Replay reads events without
executing anything. A rerun creates a new run. On startup, running attempts and
unfinished runs become interrupted; the runtime never guesses that an external
effect completed. Resuming side-effecting work requires confirmation unless its
idempotency has been established. The system makes no exactly-once claim.

## Specialist teams

An agent pins an inline role snapshot in its graph configuration. The project
role library supplies reusable defaults; editing a library role never mutates a
saved graph or an active run. A role separates expertise and skills from the
step task, declares repository knowledge, owned paths, and produced/consumed
handoffs. Ownership is checked before a successful attempt can publish code;
Claude also checks file edits at tool time. These are application policies in
addition to the provider sandbox, not a claim of OS-level isolation.

Planning has two reviews: propose an editable team from selected repository
briefs, the file manifest, and project roles; then generate a graph from that
approved team. Both use short background start/poll requests, bounded correction,
and tool-free planning. The generated graph cannot silently widen role scope or
change an approved model assignment. Existing workflow edits can retain their
original graph-generation path. Graph validation checks team handoff ordering,
parallel ownership, and required machine-test gates as well as DAG wiring.

Handoffs are repository artifacts validated before producer success and checked
again in the consumer's code lineage. Prompt context is bounded and ordered;
the replay records supplied context and reports unavailable provider usage as
unknown. Session resume stays disabled. Later phases add deterministic tool
nodes, nested role playbooks, supervised improvement proposals, and a portable
cross-project library; these must not be represented by cosmetic controls.

## Verification boundary

Core tests use injected deterministic callbacks, never paid providers. Workspace
tests use temporary repositories and real processes. SDK availability and
authentication are reported separately from live execution. A successful
automated fixture is not evidence that a live provider account is authorized.

## Integrated terminals

The renderer uses xterm.js; the sidecar owns real host PTYs through `node-pty`.
Authenticated API calls create, write, resize, read, and close sessions. Every
request checks the project and window-owner IDs. Shells start in the open folder
and use normal host user permissions, independently of workflow approvals.

Output is raw ANSI in a 512 KiB UTF-8 memory buffer per session, read through
absolute string cursors. It bypasses SQLite, event logs, and redaction. Hidden
tabs keep polling and preserve their terminal instances. Closing a folder/window
closes its owner; late creation is blocked by an owner tombstone. A two-minute
lease cleans up abandoned renderers, with a fresh lease after machine sleep.
Runtime shutdown also stops terminals. POSIX cleanup captures shell descendants
and their job-control process groups; deliberately detached daemons are outside
that guarantee.

## Concrete stack choices

Node 24's built-in `node:sqlite` replaces an additional SQLite native binding.
Transactions and typed repositories provide the query boundary; migrations use
`BEGIN IMMEDIATE` and WAL. Graph and attempt payloads live as versioned JSON,
with indexed relational run/event/approval keys. This avoids an additional
database native binding.

The renderer uses plain scoped CSS and semantic controls instead of Tailwind and
a component framework. React Flow and Monaco provide the complex interactions;
local system fonts and bundled Monaco workers avoid renderer CDN requests.

Tauri starts a bundled Node executable and JavaScript sidecar from Rust. The
per-launch token crosses only a private stdout handshake and a Tauri command.
The renderer has no shell or filesystem capability. Development browser mode
receives the token in a launch URL fragment, immediately removes it from the
address, and retains it only in memory. Local clients without an Origin header
still need the token. Host and browser Origin are validated on every request.

Release packaging stages the exact installed provider SDK and `node-pty` versions
and the Node executable. A real PTY smoke test runs with that staged executable
before packaging. This is larger than a standalone compiled sidecar but preserves the
official SDKs' native executable resolution without extracting credential files
or making unsupported binary-bundling assumptions. Build each target on its
corresponding OS and architecture.
