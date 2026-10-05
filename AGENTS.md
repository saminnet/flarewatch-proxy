# AGENTS.md

See [README.md](README.md) for what the proxy is and how FlareWatch uses it.

- Run scripts through pnpm: `pnpm check`, `pnpm test`, `pnpm build`. The scripts call `vp` (Vite+).
- The wire contract with FlareWatch lives in `src/app.ts` and `src/types.ts`. It mirrors `services/worker/src/checkers/proxy.ts` in [saminnet/flarewatch](https://github.com/saminnet/flarewatch). Change both repos together.
- Keep `tests/fixtures/http-assertions.json` a byte-identical copy of `packages/shared/tests/fixtures/http-assertions.json` in FlareWatch. Both repos run every case in it.
- The lint rules in `tools/oxlint/anti-slop/` are vendored from FlareWatch. Keep them a byte-identical copy. Never edit them here.
- When a change makes a statement in README.md false, fix README.md in the same change.
