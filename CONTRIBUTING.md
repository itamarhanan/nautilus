# Contributing

Thanks for looking. Nautilus is a personal project, but issues and pull requests are welcome.

## Setup

```bash
corepack enable
pnpm install
pnpm dev:local     # the server, the PWA and the desktop app on one machine
```

Building the desktop app needs Rust and the [Tauri 2 prerequisites](https://tauri.app). Everything else, tests included, needs only the Node version in [`.node-version`](./.node-version) or newer, and `git`.

## Before you send a change

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm knip && pnpm test && pnpm build
```

CI runs the same six commands.

- **Add a test for a behavior change.** A sync or recovery change needs a test against real repositories. The ones in `apps/server/test/sync.test.ts` show how.
- **Keep the trust boundaries.** Anything that widens what the desktop may run, what the runner may ask of the PC, or what the public listener serves needs a reason in the pull request. [docs/architecture.md](./docs/architecture.md) describes each boundary.
- **Write comments that say why.** Comment a decision a reader would otherwise question, not what the code plainly does. A declaration gets a comment only when its name cannot carry what the comment would say; `isServing` on its own does not say that the dev server is up _and_ holding code, so that one is documented, while `isStarting` is not documented at all. Where a note explains something several declarations share, put it on the first of them rather than in a header at the top of the file — the file name and its imports already say what the file owns. Platform rules, trust boundaries and rejected alternatives are the comments worth writing.
- **Do not export what nothing else imports.** `knip` fails the build on an export no other file reads, and on a dependency nothing references. Drop the `export` keyword instead; `noUnusedLocals` then tells you whether the declaration itself is still read.
- **Keep user-facing text in `@nautilus/copy`.** Words a person reads live in the catalogue, keyed by the state they describe, so a state added to a wire type fails the build until someone has written words for it. Text that formats a value rather than naming a state — token counts, durations, currency, truncation — stays next to the arithmetic that produces it.
- **Update the docs** when you change the sync protocol or a trust boundary.

## Toolchain

One flat ESLint config at the root, written with `defineConfig` and typed linting through `projectService`, so a new package needs no lint wiring. `lint`, `knip` and `test` run from the root; `typecheck` and `build` run per package, because each package owns a tsconfig and a bundler config. A package's `tsconfig.json` is the one editors, `tsc` and the linter all read.

The six packages that ship to Node — `server`, `sync-agent`, `types`, `brand`, `copy` and `shadow-git` — build with `tsdown` rather than `tsc`. `tsc` emits one file per source file, so every relative import would have to spell out its `.js` extension for Node's ESM resolver to find it; `tsdown` bundles each package into a single `dist` file instead, so those specifiers never reach anything Node loads. Write imports without an extension. A dependency listed in `package.json` stays external and is still imported by name, so a new dependency needs no build wiring.

The one setting that is easy to get wrong is `fixedExtension: false`. `platform: "node"` turns it on by default, which renames the output to `.mjs` and breaks the `node dist/main.js` and `node dist/cli.js` that `start`, the docs and the dev scripts all run.

`knip.jsonc` finds dead code and unused dependencies across all eight workspaces. It needs no entry or project wiring, because the plugins for Next.js, Vite, Vitest, ESLint, Tailwind, PostCSS, Tauri and Oxfmt are already enabled by the packages in use, and `@nautilus/*` imports resolve to source rather than to `dist`. The config only holds what no plugin can see: the Rust side and `public/` are outside the module graph, and three dependencies are reached through an installed binary path or a spawned process rather than an import.

TypeScript is strict across the workspace, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The two React apps turn `exactOptionalPropertyTypes` off, and say so in their tsconfig: every remaining violation there is a prop passed to `@astryxdesign`, whose types are declared as `prop?: T`. Prefer a guard over `!` — the lint config rejects non-null assertions.

## Layout

See [the repository layout](./README.md#repository-layout). Shared wire types go in `packages/types`. Code that both the runner and the PC's agent run goes in `packages/shadow-git`. Words a person reads live in `packages/copy`.

## License

By contributing you agree that your work is licensed under the [GPL-3.0](./LICENSE).
