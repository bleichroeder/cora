# Contributing to Cora

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- what you did;
- what you expected;
- what happened instead.

Include your Cora version (Settings shows it) and your Windows version. Logs help a lot. They're in
`%USERPROFILE%\.cora`:

- `server.log` for the server;
- `desktop.log` for the window;
- `ptyhost.log` for terminals.

Look through a log before attaching it. Cora keeps secrets out of its logs, but your session names and folders appear
there.

For anything security-related, please read [SECURITY.md](SECURITY.md) first and report it privately.

## Suggesting a feature

Open an issue saying what you're trying to get done and where Cora gets in the way. The problem matters more to us than
a proposed solution; we'll work out the shape together.

## Working on the code

Everything you need is in [Development](docs/development.md): the repo layout, running Cora from source, the simulator
(fake sessions to work against), tests and packaging. The short version:

```bash
npm install
npm run build
npm test                 # vitest across all packages
npm run typecheck
npm run desktop          # the Electron app, from source
```

A few things we care about:

- **Tests with the change.** Logic lives in pure functions where possible (the client's `lib/`, the `shared` package)
  so it can be tested without a DOM.
- **The design language.** The UI follows [docs/design-language.md](docs/design-language.md).
- **Plain words.** Labels, hints and messages say what happens, in short sentences, without jargon. The same goes for
  comments: say why, not what.
- **Security first.** Anything that touches keys, the hooks, Cora's agent, the browser or another person's text needs
  a look at [Security and privacy](docs/guide/security-and-privacy.md). Ask in the PR if you're unsure.

## Pull requests

- Keep each PR to one change, with a description of what and why.
- Make sure `npm test` and `npm run typecheck` pass.
- Screenshots or a short clip help for anything visual. The simulator (`--sim`) is handy for those.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
