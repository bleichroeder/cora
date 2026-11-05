# End-to-end tests against a throwaway Cora

A second Cora with its own home folder and port. Use it to try a change in a real running Cora without touching the user's: theirs runs from `C:\code\cora` on port **4317**. Never use that port, `~/.cora`, or their window.

## Run one

From your worktree's root:

```sh
npm run build -w packages/client                      # the UI this Cora serves is your worktree's build
ROOT="$TEMP/cora-e2e-$(date +%s)"                     # a fresh folder each run
npx tsx scripts/e2e/serve.mts "$ROOT" 4399            # leave it running (in the background)
```

- **Open the UI:** `http://127.0.0.1:4399/`. Set the cookie `ab_session=e2e` first (or log in with the token `e2e`).
- **Call the API:** send the headers `cookie: ab_session=e2e` and `origin: http://127.0.0.1:4399`.
- **Server changes:** they're picked up when you start `serve.mts` again. It runs your worktree's server source through tsx, so no build is needed.
- **Its sessions:** they're real Claude Code sessions. Their working folder is `$ROOT/work`, and they start without the user's settings, so their hooks never reach the real Cora. Keep test sessions on haiku.
- **Transcripts (`--tail`):** by default it reads only hook events, so there's no token usage, context size or reply text. To check those (the context nudge, the agent's context cap, usage), start it with `CORA_E2E_TAIL=1` or `--tail`: `npx tsx scripts/e2e/serve.mts "$ROOT" 4399 --tail`. It then reads its own sessions' transcripts, and only those, Cora's agent's included. `$ROOT/transcripts` gets a junction to each folder in `~/.claude/projects` named for a folder under `$ROOT`, added as they appear: its work folder and its worktrees, the agent's `home/orchestrator`, and a team builder's folder. It refuses to start unless `$ROOT` is inside the temp folder, so a broad root can't take in your own transcripts.
- **Nothing of yours:** its journal is `$ROOT/journal`, not Documents\Cora\Journal. Its Resume and search see only `$ROOT/transcripts`: its own transcripts with `--tail`, none without. It has no kubeconfigs (`$ROOT/kube`), so it never checks your clusters. Its notes, explains, debriefs and attachments are in `$ROOT/home`, as before.
- **Marked as yours:** `serve.mts` sets `CORA_SPAWNED_BY` (your session's id, from `CLAUDE_CODE_SESSION_ID`) and `CORA_SPAWN_WHY` for them. If any of them does reach the user's Cora, it shows as a folded sub-row under your session, not as a loose row at the bottom of the nav. Any tool that starts sessions can set the same two variables. A session in a `cora-e2e-…` folder with no marker is treated the same way.

## What's here

- `serve.mts`: the throwaway Cora.
- `team-flow.mjs`: the team flow end to end. It runs a draft with a missing folder and a worktree seat, Apply and bring-up, the seats' agent files, and messages from you to the lead to the worker and back. Run it with `node scripts/e2e/team-flow.mjs "$ROOT" 4399` while `serve.mts` runs; it prints PASS/FAIL per check. It takes a few minutes.

For a UI change, drive the page with a headless browser (Playwright) through the flow the change touches. Take screenshots of what you check.

## Clean up after every run

1. Stop `serve.mts`, and any `claude.exe` still working in `$ROOT/work`.
2. Delete `$ROOT`. Once the folder is gone, Cora takes its ended sessions off the nav (within a minute, or as soon as another session ends).
3. Delete the test sessions' transcripts: the folders under `~/.claude/projects/` whose names contain the root's folder name (e.g. `*cora-e2e-1730...*`). Touch nothing else there. (With `--tail`, `$ROOT/transcripts` only holds junctions to those same folders. Delete `$ROOT` after them, or remove the junctions with `cmd /c rmdir`, which never follows them.)
