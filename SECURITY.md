# Security

Cora sits next to everything you work on: your Claude Code sessions, your terminals, and the services you connect
(Slack, Gmail, Jira, GitLab, your clusters, 1Password). We take that seriously, and we'd much rather hear about a
problem from you than read about it.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Instead, use GitHub's private reporting: on this
repository, open **Security › Report a vulnerability**. Tell us what you found, how to reproduce it, and what you think
an attacker could do with it.

You'll hear back within a few days. Once there's a fix, it ships as a new release (installed copies update
themselves), and we'll credit you in the release notes unless you'd rather we didn't.

## Supported versions

Only the latest release gets security fixes. Cora updates itself, so you're on it unless you've turned updates off.

## How Cora is built to be safe

The full story is in [Security and privacy](docs/guide/security-and-privacy.md). In short:

- **Local only.** Cora's server listens on `127.0.0.1`, never on your network. Every request needs a key, and anything
  that acts also needs Cora's own origin.
- **Separate keys for separate jobs.** The dashboard, Claude Code's hooks, Cora's own agent, a read-only view, and the
  terminal host each have their own key, so one can't stand in for another.
- **Secrets stay sealed.** Sign-ins for Slack, Google and ElevenLabs are encrypted with a key Windows protects for your
  user (DPAPI). Passwords from 1Password are never stored: they go from 1Password straight into the page you asked
  to fill.
- **Sessions can't act as you.** Claude sessions reach Cora's tools through their own key and can't approve their own
  prompts, send messages as you without your OK, or read your secrets.
- **Other people's words are data.** Text from Slack, email and Jira is always marked as someone else's and never
  treated as instructions, by Cora or by the sessions it hands it to.
- **The built-in browser is fenced.** Pages run sandboxed, can't open anything that isn't a web page, and sites a
  session wants to open wait for your OK unless you plainly use them.

The installer isn't code-signed yet, so Windows SmartScreen may warn you the first time. Each release lists its
installer's SHA-512 in `latest.yml`, so you can check the file you downloaded.
