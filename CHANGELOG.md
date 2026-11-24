# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Repository metadata: LICENSE (MIT), NOTICE, CONTRIBUTING, English README (Chinese moved to README.zh-CN.md), issue / PR
  templates, CI workflow, GitHub Pages deployment workflow, Dependabot, `.editorconfig`.
- `docs/ALGORITHMS.md`: algorithm and implementation reference (equations, discretisation, CPU functions and GPU kernels,
  verification), shown in the app under Help → Algorithm documentation with KaTeX formulas; the model panel links to the
  matching sections.
- Verification suite (`src/verify/cases.ts`, 14 cases with thresholds) run in a worker from Help → Algorithm verification
  and by `npm test` (`tests/verify.test.ts`), with analytical-vs-numerical plots.
- Coriolis force (f-plane, exact rotation) and uniform wind stress (Wu 1982 drag) on CPU and GPU, new model panel section
  "⑦ 科氏力与风场".
- Open-sea boundary: external level (+ tide) and current as the far-field state of the boundary Riemann problem
  (characteristic / Flather-type, non-reflecting), with the geostrophic tilt when rotation is on.
- Uniform initial current (geostrophically balanced surface when rotation is on).
- Bed shear stress output (colour mode, hover read-out, ASCII export).
- Built-in case "海底地形中的洋流": ocean current past a seamount, island and ridge with a saddle.

### Fixed
- Free-outflow boundary on sloping beds: ghost cells continued the bed flat and acted as a pool, building an M1 backwater
  upstream (+79 % outlet depth in a 0.1 % channel). Ghost beds now continue the downhill slope (normal-depth assumption).
- Second-order scheme: implicit friction is applied inside each Heun stage, so uniform flow is an exact fixed point
  (previously ~1 % steady discharge error).
- Switching to a derived colour mode while paused now uploads the field immediately.

## [0.1.0]

### Added
- 2D shallow-water finite-volume solver (HLL + hydrostatic reconstruction, optional MUSCL / Heun, implicit Manning
  friction, CFL-adaptive step) on CPU (Web Worker) and WebGPU.
- Terrain from online open DEM, ESRI ASCII Grid and synthetic generators; depression filling.
- Manning roughness field: base value, OpenStreetMap land use, hand-drawn zones.
- Buildings (OpenStreetMap import / hand-drawn; blocking or high-roughness mode).
- Hydraulic structures: levees, weirs, gates, breaches, culverts, pumps.
- Boundary conditions, initial water polygons, point inflows (incl. GloFAS), rainfall (incl. ERA5), infiltration.
- Three.js 3D visualisation, result envelopes, gauges and sections, timeline playback, CSV / ASC / PNG export,
  `.hydrosim.json` project files.
- Built-in benchmark, synthetic and real-terrain cases (Malpasset, Ahr 2021).
