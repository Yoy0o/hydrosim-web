# Third-party data and attribution

HydroSim Web's source code is MIT-licensed (see [LICENSE](LICENSE)). The data below is **not** covered by that
licence and keeps its original terms.

## Bundled offline data (`public/data/`)

| File | Content | Source / terms |
|---|---|---|
| `malpasset.json` | DEM of the Malpasset dam-break area (Fréjus, France), resampled | AWS Open Data Terrain Tiles (SRTM, GMTED2010, ETOPO1, NED …), attribution per [Tilezen/joerd](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) |
| `ahr.json` | DEM of the Ahr valley (Germany), resampled | same as above |
| `ahr2021_forcing.json` | Hourly precipitation and daily river discharge, July 2021 | [Open-Meteo](https://open-meteo.com) Historical Weather API (ERA5 / ERA5-Land, Copernicus) and Flood API (GloFAS v4), CC BY 4.0 |

## Data fetched at runtime (needs network)

| Data | Provider | Terms |
|---|---|---|
| Global DEM | AWS Open Data Terrain Tiles | see above |
| Historical rainfall / river discharge | Open-Meteo | CC BY 4.0 |
| Satellite imagery | EOX Sentinel-2 cloudless 2016 | CC BY 4.0, contains modified Copernicus Sentinel data |
| Base map | OpenStreetMap | ODbL, © OpenStreetMap contributors; follow the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) |
| Buildings and land use | OpenStreetMap via [OpenFreeMap](https://openfreemap.org) vector tiles (OpenMapTiles schema) | ODbL, © OpenStreetMap contributors, © OpenMapTiles |

If you redistribute results or screenshots that include these layers, keep the attributions above.

## Benchmarks and references

The built-in validation cases re-implement published test problems (Fennema & Chaudhry 1990; Kawahara & Umetsu;
Brufau et al.; Thacker 1981; Malpasset dam break 1959). No third-party code or data from those works is included.

## Libraries

Runtime dependencies are installed from npm and keep their own licences: three (MIT), leaflet (BSD-2-Clause),
uPlot (MIT), pbf (BSD-3-Clause), @mapbox/vector-tile (BSD-3-Clause).
