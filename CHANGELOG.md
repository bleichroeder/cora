# Changelog

What changed in each release. Cora updates itself; each update's notes are on its release page too.

## Unreleased

- **Live explains.** For work that runs for minutes, Claude keeps a dashboard that updates in place as it works: tests
  passing, a build's stages, a deploy. Every HTML explain also gets Cora's colours, so it looks like part of Cora.
- **Explains have versions.** Written again under the same title, an explain gets a new version instead of a copy;
  step back through them in the viewer.
- **Quieter Slack.** Slack's own notifications only while you're away from Cora, not for every message while you're
  in it.
- **Share an explain.** Its session publishes a copy as a claude.ai artifact, and you get a link to send; update it
  to the newest version later, at the same link.
- **Cora is pink**, its default colour, icon and installer.

## 0.1.3

The first public release. Cora now updates from this repository's releases.

- **Find in Tools.** Ctrl+F works in the Tools drawer and in Tool windows. Esc in the page closes find, and its
  highlights always clear.
- **Your own work tools.** In Settings › Cora › Work tools you tell Cora about your MCP servers and which of their tools
  only read.
- **Clearer views.**
  - In the 3D scene, a subagent's helpers keep clear of each other, and the "waiting for you" ring no longer covers the
    text under it.
  - The galaxy groups sessions by folder.
  - An explain's card in the transcript reads as plain text.
  - Checklists show one box per item.
  - The Changes tab counts each file once.

## 0.1.2

- **1Password at the field.** A key in a page's login field opens your 1Password logins right under it. Focusing one
  suggests the site's logins while 1Password is unlocked. This works in session tabs, Tools in the drawer, and Tool
  windows.
- **Questions with more answers.** Claude's question cards take several answers and an **Other…** of your own. MCP forms
  check their required fields.
- **Long sessions.** A session's earlier events load from the timeline.
- **Kept in bounds.** Logs roll over, old terminals are let go, and Cora's database compacts itself.
- **Fixes.** Setup's install buttons open their window again. Esc in the composer keeps your draft. Failures that used
  to be silent now say so. Electron security patches install reliably.
- **The user guide**, in `docs/guide`.

## 0.1.1

- **Security hardening** across the board:
  - separate keys for the dashboard, hooks, Cora's agent and the terminal host;
  - sign-ins sealed with Windows DPAPI;
  - other people's words always marked as data;
  - the agent's commands checked more strictly;
  - the built-in browser fenced in.
- **Drafts and approvals survive a restart.**
- **Chrome and Edge bookmarks and history** in the browser's address bar.
- **1Password** in Cora's browser.

## 0.1.0

The first release: sessions, the 3D scene, transcripts and explains, permission prompts in one place, terminals that
survive restarts, Cora's assistant, voice, and the Jira, Slack, Gmail, GitLab and deploy integrations.
