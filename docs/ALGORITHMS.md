# HydroSim Web 水动力算法与实现说明

> 本文是**算法核验手册**：每一节给出 ① 物理方程与离散公式，② 代码中的实现位置（CPU 参考实现 [`src/core/solver.ts`](../src/core/solver.ts)，GPU 实现 [`src/gpu/kernels.ts`](../src/gpu/kernels.ts)），③ 对应的核验算例、指标与通过阈值。
> 应用内"帮助 → 算法与实现文档"打开本文，模型面板各节的"📖"链接直接跳到对应章节；"帮助 → 算法核验"在后台线程运行全部核验算例（与 `npm test` 使用同一套代码和阈值）。

## 0 阅读指引

### 0.1 文档与代码的对应关系

| 模块 | 文件 | 主要函数 / 内核 |
|---|---|---|
| 求解器（CPU，双精度） | [`src/core/solver.ts`](../src/core/solver.ts) | `SWESolver.step`、`fluxSweep`、`computeSlopes`、`updateCells`、`postStep`、`applyBoundaries`、`ghost`、`fillBedGhosts` |
| 求解器（GPU，单精度） | [`src/gpu/kernels.ts`](../src/gpu/kernels.ts)、[`src/gpu/gpuEngine.ts`](../src/gpu/gpuEngine.ts) | `BC`、`ZLINE`、`SLOPES`、`FLUX`、`SCALAR`、`BFLUX`、`UPDATE`、`STATS`、`FINALIZE`、`PACK` |
| 过程线插值与精确积分 | [`src/core/timeseries.ts`](../src/core/timeseries.ts) | `sampleSeries`、`integrateSeries` |
| 解析解 | [`src/core/analytic.ts`](../src/core/analytic.ts) | `ritter`、`stoker`、`thackerSurface` |
| 模型输入（地形、糙率场、结构） | [`src/model.ts`](../src/model.ts) | `buildModelInputs`、`structureSeries` |
| 派生量（底床剪切应力） | [`src/core/derived.ts`](../src/core/derived.ts) | `bedShear`、`bedShearField` |
| 初始条件 | [`src/core/geometry.ts`](../src/core/geometry.ts)、[`src/app.ts`](../src/app.ts) | `initialDepth`、`App.computeInitialState` |
| 核验算例 | [`src/verify/cases.ts`](../src/verify/cases.ts) | `CASES`、`runCase` |

### 0.2 如何核验

1. **应用内**："帮助 → 算法核验"（或"⑧ 计算设置 → 运行算法核验"）。每个算例在 Web Worker 中运行，显示指标、阈值、结论以及数值解与解析解的对比曲线，并可跳转到本文对应章节。
2. **命令行**：`npm test` 运行全部单元测试与核验算例（[`tests/verify.test.ts`](../tests/verify.test.ts) 调用同一个 `CASES` 列表，阈值不满足即测试失败）。
3. **GPU 一致性**：开发模式下打开 `/gpu-test.html?run=parity`（全部内置算例 CPU/GPU 对比）或 `?run=structures`；应用内核验的"GPU 引擎一致性"算例覆盖科氏力、风应力、外海边界与二阶格式。
4. **模拟过程中**：右侧"实时统计"给出水量平衡与质量误差（§11）；观测点、断面流量与"水量平衡"图表可与理论值对照；底部状态栏显示光标处水深、流速、弗劳德数与底床剪切应力。

### 0.3 符号表

| 符号 | 含义 | 单位 |
|---|---|---|
| $h$ | 水深 | m |
| $z$ | 床面高程 | m |
| $\eta = h + z$ | 水位 | m |
| $u, v$ | 东向、北向深度平均流速 | m/s |
| $q_x = hu,\ q_y = hv$ | 单宽流量（守恒变量） | m²/s |
| $g$ | 重力加速度（9.81） | m/s² |
| $n$ | 曼宁糙率 | $\mathrm{s/m^{1/3}}$ |
| $f = 2\Omega\sin\varphi$ | 科氏参数 | 1/s |
| $\Delta x, \Delta y, \Delta t$ | 网格尺寸与时间步长 | m, s |
| $h_{dry}$ | 干湿阈值（默认 $10^{-6}$ m） | m |

## 1 控制方程

二维深度平均浅水方程（静水压力假定，密度均匀），守恒形式：

$$
\frac{\partial \mathbf U}{\partial t}+\frac{\partial \mathbf F}{\partial x}+\frac{\partial \mathbf G}{\partial y}=\mathbf S_b+\mathbf S_f+\mathbf S_c+\mathbf S_w+\mathbf S_m
$$

$$
\mathbf U=\begin{pmatrix}h\\ hu\\ hv\end{pmatrix},\quad
\mathbf F=\begin{pmatrix}hu\\ hu^2+\tfrac12 gh^2\\ huv\end{pmatrix},\quad
\mathbf G=\begin{pmatrix}hv\\ huv\\ hv^2+\tfrac12 gh^2\end{pmatrix}
$$

源项依次为底坡、底床摩阻（曼宁）、科氏力、风应力与质量源汇：

$$
\mathbf S_b=\begin{pmatrix}0\\ -gh\,\partial_x z\\ -gh\,\partial_y z\end{pmatrix},\quad
\mathbf S_f=-\frac{g n^2\lvert\mathbf V\rvert}{h^{1/3}}\begin{pmatrix}0\\ u\\ v\end{pmatrix},\quad
\mathbf S_c=\begin{pmatrix}0\\ f\,hv\\ -f\,hu\end{pmatrix},\quad
\mathbf S_w=\frac{1}{\rho_w}\begin{pmatrix}0\\ \tau_{wx}\\ \tau_{wy}\end{pmatrix}
$$

$\mathbf S_m$ 为降雨 $R(t)$、下渗 $I$、点源 $Q(t)/A$ 等只作用于水深的质量项（§9）。模型不含水平紊动黏性与色散（见 §16 的改进建议）。

## 2 网格与数据布局

- **网格**：均匀笛卡尔网格，单元中心存储，$\Delta x$ 与 $\Delta y$ 可不相等。局部坐标 $x$ 向东、$y$ 向北，原点为计算域西南角。地理坐标地形定义在 Web 墨卡托平面上，真实网格尺寸为墨卡托尺寸乘以区域中心纬度的 $\cos\varphi$。
- **编号**：内部单元 $(i,j)$ 的行优先序号 $c = j\,n_x + i$（$j=0$ 为最南一行）。求解器四周各加两层虚拟单元，填充后数组宽度 $N_X = n_x+4$，单元 $(i,j)$ 的填充序号为 $(j+2)N_X + (i+2)$（`SWESolver.idx`）。
- **存储**：CPU 为 `Float64Array` 的 $h, hu, hv, z$；GPU 每个单元一个 `vec4<f32>` $(h, hu, hv, z)$。
- **界面**：$x$ 向界面 $(n_x+1)\,n_y$ 个、$y$ 向界面 $n_x\,(n_y+1)$ 个，通量按界面存储，单元更新时取左右（下上）界面差分。

## 3 数值通量：HLL 近似黎曼求解器

**实现**：CPU `fluxSweep`（x、y 两个方向复用，法向/切向速度互换）；GPU `FLUX` 内核中的 `hll()`。

每个界面先做静水重构（§4）得到左右状态 $(h_L^*, u_L, v_L)$、$(h_R^*, u_R, v_R)$（$u$ 为法向、$v$ 为切向速度），HLL 通量为

$$
\mathbf F^{HLL}=\begin{cases}\mathbf F_L, & s_L\ge 0\\[2pt] \dfrac{s_R\mathbf F_L-s_L\mathbf F_R+s_Ls_R(\mathbf U_R-\mathbf U_L)}{s_R-s_L}, & s_L<0<s_R\\[6pt] \mathbf F_R, & s_R\le 0\end{cases}
$$

波速采用 Toro 的双稀疏波估计（含干底波速）：

$$
c_{L,R}=\sqrt{g h^*_{L,R}},\quad u_*=\tfrac12(u_L+u_R)+c_L-c_R,\quad c_*=\tfrac12(c_L+c_R)+\tfrac14(u_L-u_R)
$$

$$
s_L=\min(u_L-c_L,\ u_*-c_*),\qquad s_R=\max(u_R+c_R,\ u_*+c_*)
$$

左侧干时 $s_L=u_R-2c_R,\ s_R=u_R+c_R$；右侧干时 $s_L=u_L-c_L,\ s_R=u_L+2c_L$（干底稀疏波波前速度 $u\pm 2c$）。

**切向动量**按质量通量方向迎风：$F_2 = F_0\,v_L$（$F_0\ge 0$）或 $F_0\,v_R$。这使剪切波（流速的切向分量）以接触间断的方式被输运，对一维两波系统 HLL 是精确的，切向分量则相当于 HLLC 的中间波处理。

最大波速 $\max(-s_L, s_R)$ 用于 CFL 时间步长（§10）。

**核验**：`ritter`（干底溃坝，L1 相对误差一阶 0.80%、二阶 0.25%，阈值 3% / 1.5%）、`stoker`（湿底溃坝，0.67% / 0.24%）。

## 4 静水重构与底坡源项（Chen–Noelle）

**实现**：CPU `fluxSweep` 开头与 `updateCells` 中的 `sbx/sby`；GPU `FLUX` 内核（重构）与 `UPDATE` 内核（源项）。

界面底高与重构水深（Chen & Noelle, 2017）：

$$
z^*_{i+1/2}=\min\!\big(\max(z_L, z_R),\ \min(\eta_L,\eta_R)\big),\qquad
h^*_{L}=\min(\eta_L-z^*,\ h_L)^+,\quad h^*_{R}=\min(\eta_R-z^*,\ h_R)^+
$$

单元 $i$ 的底坡源项用子单元形式离散：

$$
S_{b,i}=-\frac g2\,\big(h^{*}_{L,i+1/2}+h^{*}_{R,i-1/2}\big)\,\frac{z^*_{i+1/2}-z^*_{i-1/2}}{\Delta x}
$$

性质：

- **静水和谐**（well-balanced）：$\eta$ 为常数、流速为零时通量差与源项逐位抵消，包括干湿交界与露出水面的岛屿；
- **非负性**：$h^*\le h$ 保证 CFL 条件下水深不为负；
- **陡坡薄层**：与 Audusse (2004) 重构相比，取 $\min(\cdot,\eta)$ 的界面底高避免了薄水层在陡坡上重力项被严重低估（降雨产流尤为重要）。

**GPU 单精度处理**：重构中的床面高程一律取**相对于左单元**的差值（相邻高程差在 f32 中精确），因此高海拔或深海地形上的薄水层仍保持毫米级精度；源项中跨单元的 $\Delta z^*$ 由相对值与相邻床面差组合得到。

**核验**：`lake-at-rest`（带岛屿与干湿边界的起伏地形，一阶/二阶各 300 步，最大流量 $6\times10^{-15}$ / $8\times10^{-15}$ m²/s，阈值 $10^{-10}$）。

## 5 二阶格式：MUSCL + Heun

**实现**：CPU `computeSlopes`、`fluxSweep`（传入斜率数组）、`updateCells(stage=1/2)`；GPU `SLOPES`、`FLUX`（`ORDER=2`）、`UPDATE`（`STAGE=1/2`）、`COPY_U0`。

- **重构变量**：$(\eta, h, u, v)$ 的 minmod 限制半斜率 $\sigma_i=\tfrac12\operatorname{minmod}(w_i-w_{i-1},\ w_{i+1}-w_i)$；本单元或相邻单元为干时斜率取零（干湿前沿退化为一阶）。界面床面由重构值推出 $z=\eta_{rec}-h_{rec}$，从而重构后仍满足静水和谐。
- **时间推进**：Heun（SSP-RK2），**摩阻在每一级内隐式施加**（IMEX，记 $\mathcal F_{\Delta t}$ 为 §6.1 的隐式摩阻算子）：

$$
\mathbf U^{(1)}=\mathcal F_{\Delta t}\big(\mathbf U^n+\Delta t\,L(\mathbf U^n)\big),\qquad
\mathbf U^{n+1}=\tfrac12\Big(\mathbf U^n+\mathcal F_{\Delta t}\big(\mathbf U^{(1)}+\Delta t\,L(\mathbf U^{(1)})\big)\Big)
$$

  随后再施加质量源汇、风应力、流速上限与科氏力（§10 的步内顺序）。两级使用同一个 $\Delta t$（由第一级的最大波速确定）；第二级边界条件取 $t+\Delta t$ 时刻的值。
- **一阶**：$\mathbf U^{n+1}=\mathcal F_{\Delta t}\big(\mathbf U^n+\Delta t L(\mathbf U^n)\big)$，摩阻在 `postStep` 中施加。

**核验**：`ritter`、`stoker`（二阶误差约为一阶的 1/3）、`thacker`、`manning-normal`（二阶在均匀流中精确保持正常水深，误差 $3\times10^{-6}$）。

## 6 底床摩阻与底床剪切应力

### 6.1 隐式曼宁摩阻

**实现**：CPU `postStep`（一阶）与 `updateCells` 的 `frictionScale`（二阶各级）；GPU `UPDATE` 内核与 `frictionScale()`。

摩阻项 $\partial_t \mathbf q=-g n^2\lvert\mathbf q\rvert\mathbf q/h^{7/3}$ 对流量模 $q=\lvert\mathbf q\rvert$ 全隐式离散：

$$
q^{n+1}+a\,(q^{n+1})^2=q^*,\qquad a=\frac{\Delta t\, g n^2}{h^{7/3}}
\quad\Rightarrow\quad
q^{n+1}=\frac{2q^*}{1+\sqrt{1+4aq^*}}
$$

方向保持不变（$\mathbf q^{n+1}=\mathbf q^*\,q^{n+1}/q^*$）。该解无条件稳定、单调递减且不会使流向反转，薄水层（$a$ 很大）时流速自然趋于零。$n$ 可为逐网格糙率场（§13）。

### 6.2 摩阻与时间推进的耦合

一阶格式中摩阻在通量更新之后施加，稳态满足 $\Delta t\,g h S_0=\Delta t\,g n^2 q^2/h^{7/3}$，即离散稳态精确对应曼宁均匀流。二阶 Heun 若在整步之后才施加摩阻，第二级的通量会作用在"只加速、未减速"的中间状态上，稳态流量偏差约为 $\tfrac12 g S_0 \Delta t/u$（`manning-normal` 中约 1%）。因此二阶格式把隐式摩阻放进每一级（§5 公式），均匀流成为离散格式的精确不动点。

### 6.3 底床剪切应力

**实现**：[`src/core/derived.ts`](../src/core/derived.ts) `bedShear`；显示为着色变量"底床剪切应力 τb"，状态栏读数与"导出 → 当前底床剪切应力 (.asc)"。

与求解器的摩阻律一致：

$$
\tau_b=\rho\,g\,n^2\,\frac{\lvert\mathbf V\rvert^2}{h^{1/3}}=\rho\,C_d\,\lvert\mathbf V\rvert^2,\qquad C_d=\frac{g n^2}{h^{1/3}}
$$

$\rho$ 取"⑦ 科氏力与风场"中的水体密度（淡水 1000、海水 1025 kg/m³）。水深小于 1 cm 处不计算（薄层上的值没有物理意义）。$\tau_b$ 可与泥沙起动临界剪切应力（细砂约 0.1–0.3 Pa）比较，用于评估冲刷与海底底质稳定性。

**核验**：`manning-normal`（2 km 渠道、坡度 0.1%、$q=1$ m²/s、$n=0.03$：正常水深 $h_n=(nq/\sqrt{S_0})^{3/5}=0.9689$ m；二阶误差 $3.4\times10^{-6}$，一阶水深 −0.93%、单元流量 −2.05%，后者是一阶静水重构在坡面上的界面水深差 $\delta=S_0\Delta x$ 造成的：界面通量比单元流量大 $\delta(c-u)/2$，界面通量严格等于 1，随网格加密收敛）。

## 7 科氏力与风应力

### 7.1 科氏力（f 平面，精确旋转）

**实现**：CPU `postStep`；GPU `UPDATE` 内核末段。参数在"⑦ 科氏力与风场"设置，$f=2\Omega\sin\varphi$，$\Omega=7.2921\times10^{-5}$ s⁻¹。

科氏项 $\partial_t u = f v,\ \partial_t v=-f u$ 的解是速度矢量以 $f$ 的角速度顺时针旋转（北半球），对每个湿单元按旋转角 $\theta=f\Delta t$ 精确积分：

$$
\begin{pmatrix}q_x\\ q_y\end{pmatrix}^{n+1}=\begin{pmatrix}\cos\theta & \sin\theta\\ -\sin\theta & \cos\theta\end{pmatrix}\begin{pmatrix}q_x\\ q_y\end{pmatrix}^{*}
$$

旋转不改变 $\lvert\mathbf q\rvert$，而隐式摩阻与流速上限只依赖 $\lvert\mathbf q\rvert$，三者可交换次序。GPU 单精度中 $\cos(f\Delta t)$ 会舍入为 1，纯旋转会使 $\lvert\mathbf q\rvert$ 每步增大约 $\theta^2/2$，因此旋转后按原模长重新归一。

**核验**：`coriolis-inertial`（均匀流惯性振荡一个周期，中心误差 $9\times10^{-16}$；100×100 网格保证 32 步内边界影响到不了中心）。

### 7.2 地转平衡与分裂误差

科氏力以算子分裂方式与通量更新组合。对处于地转平衡的定常状态（压力梯度力 $\mathbf P$ 与科氏力平衡），分裂格式的不动点为

$$
\mathbf q=\frac1f J^{-1}\mathbf P-\frac{\Delta t}{2}\mathbf P+O(\Delta t^2),\qquad J=\begin{pmatrix}0&-1\\1&0\end{pmatrix}
$$

首项即地转流 $f\,\mathbf k\times\mathbf q=\mathbf P$，相对误差约 $f\Delta t/2$（$f=10^{-4}$、$\Delta t=40$ s 时为 0.2%），可以忽略。

带初始流速的场景若启用科氏力，初始水面按地转平衡倾斜（[`geostrophicTilt`](../src/core/solver.ts)）：

$$
\eta(x,y)=\eta_0+\frac fg\big(v\,(x-x_c)-u\,(y-y_c)\big)
$$

外海开边界（§8.4）的外部水位同样叠加该倾斜，使边界与内部处于同一地转平衡。

**核验**：`geostrophic`（100 km × 50 km 平底海峡、$f=10^{-4}$、东向流 0.5 m/s、外海边界、模拟 1 天：最大 $\lvert u-U\rvert/U=0.15\%$，横向水面坡度与 $-fU/g$ 相差 0.06%）。

### 7.3 风应力（Wu 1982）

**实现**：`windStress`、`windDragCoefficient`（CPU `postStep` 中施加）；GPU 在 `SCALAR` 内核中按步中时刻采样风速、计算风应力写入控制块，`UPDATE` 内核施加。

$$
\boldsymbol\tau_w=\rho_a C_d\,W\,\mathbf W,\qquad C_d=\min\!\big(2.5\times10^{-3},\ (0.8+0.065\,W)\times10^{-3}\big)
$$

$W$ 为 10 m 高风速，$\rho_a=1.225$ kg/m³。风向采用气象惯例（风的**来向**，从正北顺时针计），风吹向 $\theta+180^\circ$：$\mathbf W=-W(\sin\theta,\cos\theta)$。动量源 $\Delta t\,\boldsymbol\tau_w/\rho_w$ 在摩阻之前显式加到水深大于 1 cm 的单元（`WIND_MIN_DEPTH`，更薄的水层由摩阻主导）。风速按 $t+\Delta t/2$ 采样。

**核验**：`wind-setup`（10 km、水深 5 m 的封闭水域，西风 20 m/s：稳态水面坡度 $\partial_x\eta=\tau_w/(\rho_w g h)$，数值与理论相差 0.11%，两端壅水约 0.21 m）。

## 8 边界条件

**实现**：CPU `applyBoundaries`、`ghost`、`fillBedGhosts`；GPU `BC` 内核（每个边界单元一个线程，同时写两层虚拟单元的状态与床面）。四条边独立设置。

### 8.1 闭边界（墙）

虚拟单元镜像：$h_g=h_i$，法向流量取反、切向流量不变，床面镜像。界面质量通量严格为零，切向为自由滑移。

### 8.2 自由出流

只出不进：边界单元向外流动时零梯度外推 $(h, hu, hv)$；向内流动时按墙处理（避免透射边界在坡面或山脊处"凭空"补水）。

**虚拟单元床面沿下坡方向延伸**（正常水深假定：出口处摩阻坡降等于床面坡度）：

$$
z_{g1}=z_0-\delta,\quad z_{g2}=z_0-2\delta,\qquad \delta=\max(0,\ z_1-z_0)
$$

$z_0, z_1$ 为从边界向内的第一、二个单元床面。若像水位边界那样平直延伸床面，出口相当于一个静水池：界面处水面坡度为零，缓流时形成向上游传播的 M1 壅水曲线（2026-11 的审查发现：0.1% 坡度渠道 2 h 后出口水深偏高 79%，二阶偏高 124%，渠道中段偏高 12% / 37%）。逆坡或平坡出口保持平直延伸。

### 8.3 水位过程线与正弦潮位

虚拟单元视为"外部水库"：$h_g=\max(0,\eta_b(t)-z_g)$，内部湿润时流速零梯度外推，干燥时静止；由黎曼求解器计算界面通量（对干底内域等价于溃坝入流），低于地面处不进水。潮位 $\eta_b=\bar\eta+A\sin(2\pi t/T+\varphi_0)$。

外推的流速使向外传播的波在边界处部分反射（`ocean-radiation` 中残余扰动 33%）。需要无反射边界时使用外海开边界。

### 8.4 外海开边界（特征 / Flather 型）

**实现**：`ghost` 的 `BC_OCEAN` 分支；GPU `BC` 内核 `code == 3u`。参数：平均水位、潮汐振幅/周期/初相位、外海流速 $(u_e, v_e)$（东向、北向分量）。

虚拟单元直接取**远场状态** $(h_e, u_e, v_e)$，$h_e=\eta_e-z_g$，由边界面上的黎曼问题决定入流还是出流。以西边界为例（内部在右），线性化后的特征变量为

$$
w_1=u-\frac{g}{c}\eta\ \ (\text{左行，离开计算域}),\qquad w_2=u+\frac gc\eta\ \ (\text{右行，进入计算域})
$$

左行波两侧 $w_2$ 连续、右行波两侧 $w_1$ 连续，因此进入计算域的波的强度为 $w_2(\text{远场})-w_2(\text{内部})$。内部向外传播的扰动只含 $w_1$ 分量（$w_2'=0$），不会产生反射；远场水位或流速的变化（潮汐、外海流）则以 $w_2$ 跳跃的形式进入计算域。界面中间状态满足

$$
u_b=u_e-\frac gc\,(\eta_b-\eta_e)
$$

即 Flather (1976) 辐射条件。对一维两波系统 HLL 的中间状态是精确的，所以离散后同样无反射。启用科氏力时 $\eta_e$ 叠加外海流的地转倾斜（§7.2）。

**核验**：`ocean-radiation`（20 km 水道中央 0.1 m 水丘，波离开后残余 $1.3\times10^{-5}$；同一算例用水位边界残余 33%）；`ocean-inflow`（静止水道两端施加 0.5 m/s 外海流，1 h 后全域流速误差 $10^{-14}$）；`geostrophic`。

### 8.5 床面虚拟单元与边界通量统计

| 边界类型 | 虚拟单元床面 | 状态 |
|---|---|---|
| 墙 | 镜像 | 镜像，法向动量取反 |
| 自由出流 | 顺下坡线性延伸（逆坡时平直） | 零梯度（出流）/ 墙（入流） |
| 水位 / 潮位 | 平直延伸 | 外部水位，流速外推 |
| 外海开边界 | 平直延伸 | 外部水位（+地转倾斜）与外海流速 |

边界通量按界面质量通量逐步累计为"边界流入/流出"（二阶时两级各计 $\Delta t/2$），进入水量平衡（§11）。

## 9 源汇项：降雨、下渗、点源

**实现**：CPU `postStep`；GPU `SCALAR`（积分）与 `UPDATE`（施加）。

- **过程线精确积分**：降雨强度、点源流量、泵站流量都是分段线性（或阶梯）过程线，每步加入的是 $\int_t^{t+\Delta t}$ 的精确积分（[`integrateSeries`](../src/core/timeseries.ts)），结果与时间步长无关。
- **降雨**：均匀加到所有单元。**下渗**：恒定下渗率，不超过单元现有水量，动量按水深比例缩小（流速不变）。
- **点源**：流量均分到圆心距离不超过影响半径的单元（无一单元满足时取所在单元）；负流量（取水）不超过现有水量。点源只注入质量、不注入动量。
- 应用的"注水"工具通过额外的瞬时点源实现。

**核验**：`rain-runoff`（1 km 长、1% 坡面上 100 mm/h 降雨：平衡出流/降雨 $=1$，误差 $1.5\times10^{-13}$；坡中水深与运动波解相差 16%，原因是粗网格上薄层坡面流的分辨率误差）。单元测试另检验降雨、下渗、点源的水量。

## 10 时间步长、干湿处理与稳定性措施

- **CFL 时间步**：$\Delta t=\mathrm{CFL}\cdot\min(\Delta x/\sigma_x,\ \Delta y/\sigma_y)$，$\sigma$ 为全部界面的最大波速 $\max(-s_L,s_R)$；同时受"最大时间步"、输出时刻与结束时刻约束。二阶推荐 CFL ≤ 0.45。GPU 用工作组内归约加 `atomicMax`（正浮点按 u32 比较）求最大波速。
- **干湿**：$h<h_{dry}$ 的单元视为干，流速置零；流速由 $u=hu/h$ 计算（$h>h_{dry}$）。重构保证正性，若仍出现负水深则截断为零并计入"截断量"统计（§11）。
- **流速上限**：$\lvert\mathbf V\rvert\le 25$ m/s 的安全截断（正常模拟不会触发）。
- **步内顺序**（`step`）：动态结构线床面（§13）→ 涵洞/泵站流量（步初状态）→ 边界虚拟单元 → 斜率（二阶）→ 通量 → $\Delta t$ → 守恒更新（二阶各级含摩阻）→ 点源 → 涵洞/泵站 → 降雨 → 下渗 → 风应力 → 摩阻（一阶）→ 流速上限 → 科氏力 → 统计与包络。

**核验**：`thacker`（抛物面盆地中平面水面振荡，岸线往复移动，二阶一个周期后核心区平均水深误差 2.1 cm，$D_0=1$ m）、`mass-closed`（最小水深 ≥ 0、截断量 0）。

## 11 质量守恒审计

实时统计全域水量 $V(t)$ 与累计降雨、点源入流、下渗、边界流入/流出，质量误差

$$
\varepsilon=V(t)-\big(V_0+V_{rain}+V_{in}+V_{bnd,in}-V_{inf}-V_{bnd,out}\big)
$$

CPU 双精度下应在 $10^{-12}$ 相对量级；GPU 单精度在批次内累计、CPU 用双精度累加批次总量，长时间计算的相对误差约 $10^{-8}$–$10^{-5}$。涵洞、泵站是内部转移，不改变总量。

**核验**：`mass-closed`（一阶/二阶相对误差 $8\times10^{-16}$ / $7\times10^{-15}$，阈值 $10^{-11}$），以及各算例中的质量指标。

## 12 GPU 实现映射

| 内核 | 线程映射 | 对应 CPU 函数 |
|---|---|---|
| `ZLINE` | 每个动态结构线单元 | `applyLines` |
| `BC` | 每个边界单元 | `applyBoundaries` / `ghost` / `fillBedGhosts` |
| `SLOPES`（二阶） | 每个含虚拟层的单元 | `computeSlopes` |
| `FLUX` | 每个界面（x、y 合并一次派发） | `fluxSweep` |
| `SCALAR` | 1 个线程 | $\Delta t$、过程线积分、边界水位、风应力、涵泵流量、结构线顶高、记录事件 |
| `BFLUX` | 每个边界界面 | `accumulateBoundaryFlux` |
| `UPDATE` | 每个内部单元 | `updateCells` + `postStep` |
| `STATS` / `FINALIZE` | 间接派发（仅记录步） | `computeStats` 与观测记录 |
| `PACK` | 每个内部单元 | `depthF32` / `velocityF32` |

一个批次在一个计算通道中编码数十至上千步，$\Delta t$、源项、边界水位与记录事件都在 GPU 上决定；批次结束时一次读回控制块、逐步 $\Delta t$ 历史与记录。仿真时间由 CPU 以双精度累加 GPU 回传的逐步 $\Delta t$。过程线（降雨、边界水位、点源、泵站、结构线、风速）统一打包进一个存储缓冲，按引用序号采样与积分。

**核验**：`gpu-parity`（海山地形 + 科氏力 + 风应力 + 外海边界 + 自由出流 + 初始地转流，3 h；一阶/二阶步数与 CPU 完全相同，最大水深差 $2.3\times10^{-5}$ / $6.1\times10^{-5}$ m，GPU 质量相对误差约 $10^{-8}$），以及 `gpu-test.html` 中全部内置算例的 CPU/GPU 对比。

## 13 糙率场、建筑物与水工结构

**实现**：[`src/model.ts`](../src/model.ts)（`buildModelInputs`）、[`src/core/raster.ts`](../src/core/raster.ts)；求解器中的 `applyLines`、`prepareLinks`、`postStep`。详细设计见 [`docs/DESIGN.md`](DESIGN.md) §5.8。

- **糙率场**：基础 $n$ → OpenStreetMap 土地利用类别查表 → 糙率分区（网格中心在多边形内）→ 建筑物"高糙率"模式按覆盖率 $f$ 混合 $n=(1-f)n_0+fn_b$。
- **建筑物阻水块**：4×4 子采样覆盖率 ≥ 8/16 的网格床面抬高建筑高度。
- **结构线（z 线）**：折线按 1/4 网格步长采样，对角相接处补一个网格，保证 4 连通（有限体积只经网格边交换通量，8 连通的"对角墙"会漏水）。堤防 $z=\max(z,z_c)$，堰 $z=z_c$；闸门 $z(t)=z_c(t)$，溃口 $z(t)=\min(z_g,z_c(t))$，$z_c(t)$ 为分段线性过程线，每步开始时更新床面（网格水深不变，质量守恒）。
- **涵洞**：按步初水位 $Q=\operatorname{sign}(\Delta H)\,C_dA\sqrt{2g\lvert\Delta H\rvert}$，$A=N\pi D^2/4$；**泵站**：流量过程线精确积分。单步转移量不超过取水单元水量的 90%，取水单元动量按水深比例缩放。

**核验**：`culvert`（首步流量与孔口公式完全一致，10 h 后两侧水位差 3.6 mm，质量相对误差 $4\times10^{-16}$）；单元测试检验结构线 4 连通、斜向堤防保护区不进水、溃口过流、泵站水量。

## 14 初始条件

**实现**：[`initialDepth`](../src/core/geometry.ts)、`App.computeInitialState`。

- 全域初始水位 $\eta_0$：$h=\max(0,\eta_0-z)$；水体多边形内水位覆盖全域值（水库、溃坝上游）。
- **初始流速**：所有湿单元均匀流速 $(u_0,v_0)$，$hu=h\,u_0$、$hv=h\,v_0$；启用科氏力时初始水位叠加地转倾斜（§7.2），避免启动时激发惯性振荡。
- 基准算例（Thacker、溃坝）可直接给定解析初始水深。

## 15 核验清单

全部算例定义在 [`src/verify/cases.ts`](../src/verify/cases.ts)，应用内"算法核验"与 `npm test` 使用同一阈值。下表"实测"为 2026-11 在 Node 24（CPU 双精度）与 Intel Xe-LPG 核显（GPU）上的结果。

| 算例 | 检验的算法 | 指标 | 阈值 | 实测 |
|---|---|---|---|---|
| `lake-at-rest` | 静水重构、底坡源项（§4） | 最大流量 / 水深变化 | ≤ $10^{-10}$ | $8\times10^{-15}$ / $9\times10^{-16}$ |
| `ritter` | HLL、干底波速（§3） | 水深 L1 相对误差 一阶 / 二阶 | ≤ 3% / 1.5% | 0.80% / 0.25% |
| `stoker` | HLL、激波捕捉（§3、§5） | 同上 | ≤ 3% / 1.5% | 0.67% / 0.24% |
| `mass-closed` | 守恒更新、非负性（§10、§11） | 质量相对误差 | ≤ $10^{-11}$ | $7\times10^{-15}$ |
| `rain-runoff` | 降雨积分、自由出流（§9） | 出流/降雨 − 1 | ≤ 2% | $1.5\times10^{-13}$ |
| `manning-normal` | 隐式摩阻、出流边界（§6、§8.2） | 水深相对误差 一阶 / 二阶 | ≤ 2% / 0.5% | 0.93% / $3.4\times10^{-6}$ |
| `thacker` | 干湿前沿、二阶（§10） | 核心区平均水深误差 | ≤ 5 cm | 2.1 cm |
| `coriolis-inertial` | 科氏力旋转（§7.1） | 流速误差 / $u_0$ | ≤ $10^{-6}$ | $9\times10^{-16}$ |
| `geostrophic` | 科氏力分裂、地转边界（§7.2） | 流速偏差 / $U$ | ≤ 1% | 0.15% |
| `wind-setup` | 风应力（§7.3） | 水面坡度相对误差 | ≤ 3% | 0.11% |
| `ocean-radiation` | 外海开边界（§8.4） | 残余扰动 / 初始振幅 | ≤ 2% | $1.3\times10^{-5}$ |
| `ocean-inflow` | 外海开边界入流（§8.4） | 流速相对误差 | ≤ 2% | $10^{-14}$ |
| `culvert` | 涵洞孔口公式（§13） | 首步流量相对误差 | ≤ $10^{-12}$ | 0 |
| `gpu-parity` | GPU 实现（§12） | 最大水深差 一阶 / 二阶 | ≤ 5 mm | 0.023 / 0.061 mm |

## 16 算法审查结论与改进记录（2026-11）

在补充核验算例的过程中对既有算法做了逐项审查，发现并处理了以下问题：

| 问题 | 影响 | 处理 | 核验 |
|---|---|---|---|
| 自由出流边界虚拟单元床面平直延伸，在坡面河道出口形成静水池 | 缓流 M1 壅水向上游传播；0.1% 坡度渠道 2 h 后出口水深偏高 79%（二阶 124%），中段偏高 12% / 37%；内置河谷类算例的出口附近水位偏高 | 虚拟单元床面沿下坡方向线性延伸（正常水深假定，§8.2），CPU 与 GPU 同步修改 | `manning-normal` |
| 二阶 Heun 在整步之后施加摩阻 | 第二级通量作用在未受摩阻的中间状态上，稳态流量偏差约 1% | 隐式摩阻放进每一级（IMEX SSP-RK2，§5、§6.2），均匀流成为精确不动点 | `manning-normal`（二阶误差 $3\times10^{-6}$） |
| 缺少科氏力 | 无法模拟尺度 > 10 km 的海洋、河口、大型湖泊流动（地转平衡、惯性振荡、地形对洋流的引导） | f 平面精确旋转（§7.1），初始与边界的地转倾斜（§7.2） | `coriolis-inertial`、`geostrophic` |
| 缺少风应力 | 风暴潮、风生流、湖泊风壅水只能靠边界水位近似 | Wu (1982) 拖曳系数的均匀风场（§7.3） | `wind-setup` |
| 水位/潮位边界外推流速 | 向外传播的波部分反射（33%）；"自由出流"不能入流，无法施加外海流 | 新增外海开边界：远场状态作为边界黎曼问题的一侧（特征 / Flather 型，§8.4） | `ocean-radiation`、`ocean-inflow` |
| 初始流速只能为零 | 洋流类场景需要很长的起转时间并激发惯性振荡 | 新增均匀初始流速，启用科氏力时自动做地转倾斜（§14） | `geostrophic` |
| 没有底床剪切应力输出 | 无法评估海底与河床的冲刷强度 | 新增 $\tau_b$ 着色、读数与栅格导出（§6.3） | — |

**仍可改进**（未在本轮处理，按优先级）：

1. **水平紊动黏性**（如 Smagorinsky 模型）：目前依赖格式本身的数值耗散，尾流涡街等剪切流结构对网格与格式阶数敏感。
2. **流量边界**：上游入流目前用点源表示（只有质量、没有动量），可增加按输水能力分配的边界流量过程。
3. **源项的时间二阶精度**：降雨、科氏力、风应力仍以一阶分裂施加（摩阻已改为逐级隐式），可改为 Strang 分裂。
4. **薄层流速**：$u=hu/h$ 在极薄水层中可能偏大，可采用 Kurganov–Petrova 的去奇异化公式。
5. **严格保持地转平衡的格式**：当前分裂误差约 $f\Delta t/2$，对大尺度长历时海洋模拟可考虑 well-balanced 的旋转浅水格式。
6. **非结构网格与局部加密**、一维河道–二维漫滩耦合（见 DESIGN.md 路线图）。

## 17 参考文献

- Audusse E., Bouchut F., Bristeau M.-O., Klein R., Perthame B. (2004). A fast and stable well-balanced scheme with hydrostatic reconstruction for shallow water flows. *SIAM J. Sci. Comput.* 25(6).
- Chen G., Noelle S. (2017). A new hydrostatic reconstruction scheme based on subcell reconstructions. *SIAM J. Numer. Anal.* 55(2).
- Flather R. A. (1976). A tidal model of the north-west European continental shelf. *Mém. Soc. R. Sci. Liège* 10.
- Fennema R. J., Chaudhry M. H. (1990). Explicit methods for 2-D transient free-surface flows. *J. Hydraul. Eng.* 116(8).
- Kurganov A., Petrova G. (2007). A second-order well-balanced positivity preserving central-upwind scheme for the Saint-Venant system. *Commun. Math. Sci.* 5(1).
- Stoker J. J. (1957). *Water Waves*. Interscience.
- Thacker W. C. (1981). Some exact solutions to the nonlinear shallow-water wave equations. *J. Fluid Mech.* 107.
- Toro E. F. (2001). *Shock-Capturing Methods for Free-Surface Shallow Flows*. Wiley.
- Wu J. (1982). Wind-stress coefficients over sea surface from breeze to hurricane. *J. Geophys. Res.* 87(C12).
