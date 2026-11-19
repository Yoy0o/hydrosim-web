# Contributing

Thanks for your interest in HydroSim Web! Issues and pull requests are welcome, in English or 中文.

## Setup

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Node.js ≥ 22. A WebGPU-capable browser (recent Chrome / Edge) is needed for the GPU engine; without it the app falls
back to the CPU engine.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same three commands.

## Project conventions

- `src/core/` must stay free of DOM dependencies so it can be unit-tested and run in the Worker.
- **CPU / GPU parity**: any change to numerics, sources or structures must be made in both `src/core/solver.ts` and
  `src/gpu/` (WGSL). Verify with `gpu-test.html?run=parity` and `?run=structures` in the dev server (needs a real GPU,
  so this is not part of CI).
- Add or update Vitest tests in `tests/` for solver and model changes; benchmarks with analytic or published solutions
  are preferred.
- Keep the code TypeScript-strict (`tsconfig.json`), no unused locals.
- Documentation: user-facing changes go into both README.md and README.zh-CN.md; design decisions into
  docs/DESIGN.md.
- New data sources need a licence check and an entry in [NOTICE.md](NOTICE.md). Do not commit large data files
  (offline cases in `public/data/` are kept small on purpose; use `scripts/fetch-dem.mjs`).

## Commit messages

Conventional style, matching the existing history: `feat(core): …`, `fix(gpu): …`, `docs: …`, `test: …`,
`chore: …`.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
