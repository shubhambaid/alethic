# Contributing to Alethic

Thanks for helping. This guide covers setup, the rules the project holds itself to, and how to make changes that get merged.

## Setup

You need Node 22.12 or later and Git.

```sh
git clone https://github.com/shubhambaid/alethic.git
cd alethic
npm install
npm test
```

| Script | Does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | Biome lint and format check (`npm run format` fixes formatting) |
| `npm test` | Vitest: unit, spec-example, and end-to-end tests, including the demo |
| `npm run build` | Bundles `dist/cli.js` with tsup |

Run the CLI from source with `npm run build && node dist/cli.js <command>`, or `npm link` to put `alethic` on your PATH.

CI runs all four scripts on Linux and macOS, on Node 22 and 24.

## Project rules

1. **The spec is normative.** A change to the record format updates [docs/spec.md](docs/spec.md), the JSON Schemas in [schemas/](schemas/), and the tagged examples in the spec together. `test/spec/spec-examples.test.ts` validates every example marked `<!-- alethic:schema=… -->`, so docs and schemas cannot drift apart.
2. **Trust labels must stay hard to forge.** Nothing a local process controls (environment variables such as `CI`, file paths, agent names) may raise confidence. `ci-verified` stays unreachable until provenance can be checked cryptographically. `human-confirmed` requires a named human. Changes in this area need a test showing the label cannot be obtained another way.
3. **Deterministic output.** Commands take the time from `ALETHIC_NOW` and identity from `ALETHIC_AGENT`, sort everything by stable keys, and produce byte-identical output for identical input. `resume` never uses embeddings or model calls.
4. **Nothing private in shared state.** Every write goes through the secret scan and schema validation in `src/core/write.ts`. Never add a code path that writes records around it. Fixtures and examples must not contain real credentials. Tests build fake tokens at runtime.
5. **Git is driven through `execFile`, never a shell,** and paths are checked with `src/core/paths.ts`.
6. **Small dependency footprint.** Runtime dependencies are `commander`, `yaml`, `ajv`, and `picomatch`. Adding one needs a reason in the pull request. For example, the MCP server is hand-written because the SDK would add dozens of packages. The SDK is a dev dependency, used only for tests.
7. **No network access** at runtime.

## Tests

- `test/unit/`: pure functions and small Git scenarios, such as staleness after squash merges and shallow clones.
- `test/e2e/`: the CLI run in-process against temporary Git repositories built by `test/helpers/`.
- `test/fixtures/<name>/`: repositories described as commits plus `.alethic/` files, with `{{commit:N}}` placeholders.
- `test/e2e/__snapshots__/resume-*.md`: golden briefings. When a change to `resume` alters them intentionally, run `npx vitest run test/e2e/resume-golden.test.ts -u` and read the diff as a reviewer would: is the briefing more useful?
- `test/e2e/demo.test.ts` runs `examples/demo/run-demo.sh`. When you change the demo, keep the script readable, because people run it to learn the tool.

Bug fixes should come with a test that fails without the fix.

## Agent adapters

`docs/adapters/` documents configuration for other tools. Check every file path, setting, and command against that vendor's current documentation, and update the "checked on" date. Do not write adapter configuration from memory.

## Pull requests

- Keep changes focused. A new command or record field is easier to review with its spec change, docs in `docs/cli.md`, and tests together.
- Run `npm run typecheck && npm run lint && npm test` before pushing.
- Describe what changed and why. `alethic render pr-summary` can help if you used Alethic for the work.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
