# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Repository metadata: LICENSE (MIT), NOTICE, CONTRIBUTING, English README (Chinese moved to README.zh-CN.md), issue / PR
  templates, CI workflow, GitHub Pages deployment workflow, Dependabot, `.editorconfig`.

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
