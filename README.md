# HydroSim Web · 二维水动力仿真平台（MVP）

基于 **Three.js + WebGPU + Web Worker + TypeScript** 的浏览器端二维浅水方程水动力仿真软件。
覆盖通用水动力软件（HEC-RAS 2D、MIKE 21、TELEMAC-2D、TUFLOW 等）的核心工作流：
**地形 → 网格 → 糙率 → 边界/初始条件 → 源汇项 → 计算 → 三维可视化与结果分析**，
并接入开放数据（全球 DEM、ERA5 降雨、GloFAS 河道流量、卫星影像）。

![Malpasset 溃坝（真实地形 + 卫星影像）](docs/images/malpasset.jpg)

| 非对称局部溃坝（基准） | Ahr 河谷 2021（ERA5 降雨 + GloFAS 入流） |
|---|---|
| ![](docs/images/partial-dam-break.jpg) | ![](docs/images/ahr-2021.jpg) |
| **风暴潮漫滩（水位边界）** | **在线 DEM 降雨产流 · 最大水深包络** |
| ![](docs/images/coastal-surge.jpg) | ![](docs/images/online-dem-maxdepth.jpg) |

![WebGPU 引擎：1024×614 网格（63 万单元）降雨产流，约 110–140 倍实时](docs/images/gpu-1024-rain.jpg)

## 快速开始

需要 Node.js ≥ 22（开发时使用 v24）。

```bash
npm install
```

```bash
npm run dev
```

浏览器打开 <http://127.0.0.1:5173>（默认加载"河谷洪水演进"算例；也可用 `?case=malpasset` 等参数直接打开指定算例）。

```bash
npm test
```

```bash
npm run build
```

`npm run build` 先做 TypeScript 类型检查，再输出静态站点到 `dist/`（可部署到任意静态托管）。

WebGPU 引擎验证/基准页：开发模式下打开 <http://127.0.0.1:5173/gpu-test.html>（参数 `?run=basic`、`?run=parity` 或 `?run=bench`），
在本机 GPU 上与 CPU 双精度引擎逐算例对比并测速。

## 功能一览

**前处理**
- 地形：内置合成地形；**在线开放 DEM**（地图框选 → 自动下载 AWS Terrain Tiles 并重采样到计算网格）；导入 **ESRI ASCII Grid (.asc)**；**填洼预处理**（Priority-Flood）
- 糙率：全局曼宁 n（附典型取值表）
- 边界条件（四边独立）：闭边界、自由出流、水位过程线、正弦潮位
- 初始条件：全域初始水位、**交互绘制水体多边形**（水库/溃坝）
- 源汇项：点源入流过程线（恒定/三角形/自定义/**GloFAS**），面降雨（恒定/三角形设计暴雨/自定义/**ERA5**）+ 恒定下渗
- 计算设置：时长、输出间隔、一阶/二阶格式、CFL、最大步长、干湿阈值

**求解器**
- 有限体积 Godunov 格式，HLL 黎曼求解器 + **Chen–Noelle 静水重构**（静水和谐、非负、陡坡薄层精度好）
- 可选二阶：MUSCL（minmod）+ Heun；全隐式曼宁摩阻；CFL 自适应步长；运行中可热修改参数
- **两套计算引擎**（在"⑥ 计算设置"中切换，默认自动优先 GPU）：
  - **GPU · WebGPU**（`src/gpu/`）：同一格式的 WGSL 计算着色器；时间步长、源项积分、观测记录全部在 GPU 上完成。
    与 CPU 引擎逐算例对比，水深差异 ≤ 0.3 mm、湿润网格完全一致，**比 CPU 快 22–46 倍**（Intel 核显实测），可计算百万级网格
  - **CPU · Web Worker**（`src/core/solver.ts`）：双精度参考实现；浏览器不支持 WebGPU 时自动回退
- 水量平衡审计：降雨/入流/下渗/边界进出/质量误差（CPU 双精度约 1e-15；GPU 单精度约 1e-7~1e-5）

**后处理与可视化**
- 三维地形（分层设色 + 山体阴影 / 卫星影像 / OSM 贴图、等高线、垂向夸张）
- 动态水面：真实感渲染（菲涅尔、高光、随流波纹、急流白沫）或按变量着色：水深、流速、水位、弗劳德数、危险度 h(V+0.5)、**最大水深/最大流速/最大危险度包络**、**淹没到达时间**
- 流动粒子、图例、悬停读数（坐标/经纬度、地面高程、水深、水位、流速、Fr）
- 观测点时程、断面流量、水量平衡、断面剖面、输入过程线图表（uPlot）
- 结果帧记录与**时间轴回放**（内存预算自动抽稀）
- 交互"注水"工具：按住鼠标向地形注水，实时观察汇流

**导出与工程**
- PNG 截图；观测点/断面/水量平衡 CSV；栅格 .asc（当前水深/水位/流速、最大水深/流速/危险度、到达时间、地形；在线 DEM 结果带 EPSG:3857 坐标）
- 工程文件保存/打开（`.hydrosim.json`，含地形与全部设置）

## 内置算例

| 分组 | 算例 | 说明 |
|---|---|---|
| 基准验证 | 非对称局部溃坝 | Fennema & Chaudhry (1990)，二维激波 |
| 基准验证 | 三驼峰溃坝 | Kawahara & Umetsu / Brufau 等，干湿前沿 |
| 基准验证 | Thacker 抛物面盆地 | 解析解，岸线往复移动 |
| 合成场景 | 河谷洪水演进 | 三角形洪水过程线、漫滩、堤防、城镇（默认算例） |
| 合成场景 | 风暴潮漫滩 | 南边界风暴潮水位过程，沙丘缺口进潮 |
| 真实地形 | Malpasset 溃坝（法国 1959） | 开放 DEM（离线打包），水库多边形 100 m 水位 |
| 真实地形 | Ahr 河谷洪水（德国 2021） | 开放 DEM + ERA5 逐时降雨 + GloFAS 日流量（离线打包副本） |

内置算例全部可离线运行；"在线地形"与 ERA5/GloFAS 获取需要联网。

## 开放数据源

| 数据 | 来源 | 许可 / 署名 |
|---|---|---|
| 全球 DEM（含海底地形） | [AWS Open Data · Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)（Terrarium 编码） | SRTM、GMTED2010、ETOPO1、NED 等，按 Tilezen/joerd 署名 |
| 历史降雨 | [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)（ERA5 / ERA5-Land） | CC BY 4.0 |
| 河道流量 | [Open-Meteo Flood API](https://open-meteo.com/en/docs/flood-api)（Copernicus GloFAS v4） | CC BY 4.0 |
| 卫星影像 | EOX Sentinel-2 cloudless 2016 | CC BY 4.0 |
| 底图 | OpenStreetMap | ODbL，遵守瓦片使用政策 |

所有接口均支持 CORS，浏览器直接访问。`scripts/fetch-dem.mjs` 可把任意区域的 DEM 打包为离线算例：

```bash
node scripts/fetch-dem.mjs --name mysite --bbox 103.55,30.97,103.67,31.04 --cells 256 --title "我的区域" --out public/data/mysite.json
```

## 使用提示

- 视图操作：左键平移、右键旋转、滚轮缩放；空格键 运行/暂停；Esc 退出当前工具。
- 左侧"模型设置"按 ①–⑦ 顺序配置；修改边界、糙率、源汇项、数值参数可在运行中即时生效；修改初始条件会重置模拟。
- 视窗左侧工具条：观测点、断面（流量以 起点→终点 方向的右侧为正）、入流点、水体多边形（双击/回车结束）、注水。
- 真实 DEM 建议网格 128–384；开放 DEM 原始分辨率约 30 m，更细网格不会增加地形细节。
- 窄河谷中出现异常积水时，可在"① 地形与网格 → DEM 预处理"中执行填洼。

## 目录结构

```
hydrosim-web/
├─ docs/DESIGN.md          MVP 设计文档（功能对标、架构、数值方法、数据源、验证、路线图）
├─ public/data/            离线打包的开放数据（Malpasset / Ahr DEM、Ahr 降雨与流量）
├─ scripts/fetch-dem.mjs   开放 DEM 打包脚本
├─ src/
│  ├─ core/                求解器、过程线、解析解、几何、填洼（无 DOM 依赖，可单测）
│  ├─ gpu/                 WebGPU 引擎：WGSL 计算着色器、批量调度、GPU 端记录环形缓冲
│  ├─ worker/              计算 Worker（异步引擎循环）、引擎接口与 CPU 引擎、消息协议
│  ├─ dev/                 WebGPU 引擎验证与基准页（gpu-test.html）
│  ├─ data/                DEM 瓦片、影像、ASC、Open-Meteo、合成地形、内置算例
│  ├─ viz/                 Three.js 场景、地形、水面、粒子、标注、拾取、色带
│  ├─ ui/                  顶栏、模型面板、显示面板、图表停靠区、地图选区、视窗叠加层
│  ├─ app.ts               应用控制器（状态、工具、结果存储、Worker 通信）
│  └─ io.ts                导出与工程文件
└─ tests/                  Vitest 单元测试（22 项；GPU 引擎通过 gpu-test.html 在浏览器中验证）
```

## 计算引擎性能（Intel Xe-LPG 核显，Chrome 156）

| 网格 | CPU 引擎（步/秒） | GPU 引擎（步/秒） | 加速比 |
|---|---|---|---|
| 256×256，一阶 | 92 | 2435 | 26× |
| 256×256，二阶 | 34 | 1117 | 33× |
| 512×512，一阶 | 25 | 800 | 32× |
| 1024×1024，一阶 / 二阶 | — | 212 / 70 | — |

完整 Malpasset 溃坝过程（4000 s）在 GPU 上约 5 秒算完（约 890 倍实时）。

## 已知限制

- 均匀结构网格；CPU 引擎超过约 50 万单元时变慢，GPU 引擎在核显上 100 万单元约每秒 200 步（受显存带宽限制）。
- GPU 引擎为单精度：结果与 CPU 双精度一致到毫米级，长时间降雨产流的质量相对误差约 1e-5；点源仅支持非负流量。
- 每帧需把 GPU 结果读回再交给 WebGL 渲染（百万网格约 12 MB/帧）；后续可改用 WebGPU 渲染器直接共享缓冲。
- 糙率为全局值；无水工建筑物（堰、闸、涵洞）；点源只注入质量不注入动量。
- ERA5/GloFAS 为粗分辨率再分析/模型数据，会显著低估局地极端暴雨与洪峰，仅用于演示数据链路。
- 开放 DEM 不含河道水下地形，也无建筑物；海域水深在无测深数据处以常数近似。

更多设计细节见 [docs/DESIGN.md](docs/DESIGN.md)。
