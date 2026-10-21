# Spikes

Run against Claude Code CLI 2.1.281 on Windows 11, using `claude -p --model haiku --settings <hooks.json>` in a scratch project.

## S3: Are `http` hooks silent when the server is down?
**Mostly yes.** With every hook pointing at a closed port, the session completed normally and printed its answer. Async observation hooks failed silently. The one exception was `SessionEnd`, whose failure was printed on exit:

```
SessionEnd hook [http://127.0.0.1:4399/hook/SessionEnd] failed: connect ECONNREFUSED 127.0.0.1:4399
```

**Decision (revised in addendum D):** `install` registers `SessionEnd` again. The desktop app keeps the server running, and it's the only prompt signal that a session in another terminal has exited. The one-line error appears only if a session exits while agent-brain isn't running.

## S4: Latency added by `http` hooks
No measurable difference for a 3-tool run (11.0 s with hooks vs 14.7 s without; the gap is model noise). Async hooks don't block tool execution.

## Captured payload facts (fixtures in `packages/server/test/fixtures/hooks/`)
- Header interpolation `$AGENT_BRAIN_TOKEN` + `allowedEnvVars` works.
- `SessionStart` did not fire in `-p` mode; nothing depends on it.
- `PostToolUse` carries `duration_ms`. For `Agent`, `tool_response` includes `agentId`, `description` and `prompt`, so the subagent links immediately.
- `SubagentStart` has `agent_id` and `agent_type` but no `tool_use_id`.
- `SubagentStop` includes `last_assistant_message`, which is the subagent's report.
- `UserPromptSubmit` also fires for `<task-notification>` system prompts; these are filtered out.
- `PostToolUseFailure` carries `error` (for example `Exit code 1\n…`) and `is_interrupt`.

## S1 / S2: Permission prompt interplay and AskUserQuestion answers
These need an interactive session with a real permission prompt. See the "Needs-you" testing notes in the README.

**S2 confirmed (2026-10-15, Claude Code 2.1.281):** a PermissionRequest hook answering AskUserQuestion with `decision: { behavior: 'allow', updatedInput: { ...tool_input, answers: { [question]: label } } }` answers it: the terminal shows "User answered Claude's questions: … → Blue" and "Allowed by PermissionRequest hook", and Claude carries on with that answer. `askAnswering` now defaults to `true`.
