# Provider integration

Nodal uses `@openai/codex-sdk` 0.163.0 and `@anthropic-ai/claude-agent-sdk` 0.3.303. Their installed TypeScript declarations were checked during implementation. Both use their official bundled CLI and existing official login. Nodal does not provision API keys, read browser sessions, or persist credentials. An installed CLI and a local login do not prove model entitlement or available credit.

Run local checks without starting a model turn:

```sh
pnpm exec tsx scripts/verify-provider.ts codex
pnpm exec tsx scripts/verify-provider.ts claude
```

These commands find the SDK's native executable, run `--version`, and use the official `codex login status` or `claude auth status --json` command. They report only a login state, not account details or credential contents. A failed or unrecognized authentication check stays missing/unknown; it is never presented as connected.

Authenticate through the official `codex login` or `claude auth login` flow installed on your machine. Ensure the login applies to the same user and environment as the desktop sidecar. Optional native dependencies must be installed. Unsupported platforms and missing optional packages report unavailable.

To explicitly make a live provider request, potentially consuming paid usage:

```sh
pnpm exec tsx scripts/verify-provider.ts codex --live /absolute/path/to/repository
pnpm exec tsx scripts/verify-provider.ts claude --live /absolute/path/to/repository
```

The script asks for a short response with no tools, uses read-only permissions, limits wall time, and requires a real SDK final result. Automated tests mock SDK streams and do not claim to verify live authentication, entitlement, billing, or sandbox behavior.

## Runtime contract

`runProvider({ provider, prompt, cwd, permissionMode, model, resumeId, timeoutMs, maxTurns, maxBudgetUsd, outputSchema, allowedTools, noTools, signal, onEvent })` returns `{ sessionId, output, usage, costUsd }`. Omit `model` to use the provider default. No model IDs are invented. Events include public messages, tool actions/results, file changes, terminal output, session IDs, usage, warnings, and the final result. Reasoning and thinking blocks are not exposed.

Codex uses `new Codex()`, `startThread`/`resumeThread`, and `runStreamed`. Default sandbox mode is `read-only`. Explicit edit permission enables `workspace-write`; this also authorizes commands inside the provider sandbox. Network access and web search are disabled. The `never` approval policy denies escalation rather than granting unrestricted access. There is no dangerous-full-access fallback. Dollar budgets are rejected because the SDK does not provide reliable enforceable spend limits. Token telemetry is retained; dollar cost stays unknown.

Claude uses `query({ prompt, options })`, an abort controller, and closes the query in a `finally` block. It exposes only Read by default, with Edit/Write added for explicit scoped-edit permission. Bash, Glob, Grep, subagents, web tools, notebooks, and skills are disabled. A runtime-provided file manifest supplies paths for scoped reads. Project/user settings, plugins, and external MCP configuration are not loaded. A PreToolUse hook checks scoped file paths, symlinks, hard links, Git internals, and credential-like filenames. Tools outside the configured set are denied. Use separately approved command graph nodes to run tests. Claude's max-turn and optional dollar-budget settings are forwarded to the SDK; reported cost is an estimate.

Provider cancellation is delegated to official SDK abort mechanisms. The application command runner separately terminates POSIX process groups with SIGTERM then SIGKILL. SDK-owned grandchildren are governed by each SDK's cleanup implementation, not by the application process runner.

## Workspace safety and limitations

Every attempt gets its own Git branch and worktree from a captured commit. A sequential dependent attempt can use the previous `commitAttempt` head as its base. Dirty main-working-tree edits are not silently included. Worktrees survive cancellation and failure for inspection.

Automatic task commits reject known credential filename patterns, disable Git hooks and commit signing, and never push. This filename filter cannot identify every possible secret embedded in otherwise ordinary source files.

Merge preview returns both the destination and source commit. Applying requires explicit approval and both unchanged commit IDs, and refuses a dirty destination. A conflicting merge reports conflict files and aborts the merge so main remains at its prior state; both attempt branches survive. Integration tests must be configured by the workflow after reconciliation.

Editor writes compare the original content hash and file identity before writing; external edits produce a conflict. Path traversal and symlink components are rejected, including links pointing inside the workspace. This is protection against ordinary concurrent edits, not a kernel-enforced transaction against a hostile process racing filesystem operations.

Normal local command nodes are not a hardened sandbox. They run with the user's OS permissions after explicit authorization. The process runner uses argument arrays, finite timeouts, bounded logs, credential redaction, and POSIX process-group termination. Windows currently terminates the direct child only; process-tree containment requires a Job Object implementation.

Provider sandboxes and file-tool checks are not a comprehensive security boundary against malicious repositories. Native provider tools can have wider read scopes or provider-managed scratch directories, so native Claude recursive searches are disabled. Do not use this MVP to execute untrusted code requiring container/microVM isolation. Codex preflight lists MCP configuration without starting servers, then disables discovered MCP servers, hooks, plugins, multi-agent tools, notifications, and extra writable roots through per-turn overrides. Unrecognized configuration fails closed. Official authentication remains managed by the CLI. Log redaction covers common credential forms and secret environment values, but cannot detect arbitrary private data; review exports before sharing.

Official references: [Codex SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md), [Claude TypeScript SDK](https://platform.claude.com/docs/en/agent-sdk/typescript).

## Tool-free planning

`noTools: true` sets Claude's tool list to empty. Codex rejects this request with
an actionable unsupported-planning error because its SDK cannot enforce the
same boundary. The graph builder therefore defaults to Claude. Claude custom
allowlists can only narrow the fixed scoped file-tool set; nonempty Codex custom
allowlists are rejected. No restriction silently becomes a broader permission.

Both installed adapters passed genuine streamed marker turns during verification.
The Claude marker used an empty tool list. Native availability checks, mock-stream
tests, and live marker tests are reported separately.

Structured graph schemas target draft-7 because the installed Claude SDK rejects
the newer Zod default dialect. The planner allows six bounded SDK turns per
request for structured output, with at most two requests and no execution tools.
The live preview verifier and Codex workflow verifier are documented in
[TESTING.md](TESTING.md).
