<p align="center">
  <img src="https://raw.githubusercontent.com/lizi600jin/dsh-ensp/HEAD/assets/icon.webp" alt="dsh-ensp" width="180" height="180">
</p>

<p align="center">
  <strong>中文</strong> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ensp"><img alt="npm" src="https://img.shields.io/npm/v/dsh-ensp?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/dsh-ensp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-ensp?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/lizi600jin/dsh-ensp/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/lizi600jin/dsh-ensp?style=flat-square&color=eab308"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square"></a>
</p>

# dsh-ensp

面向华为 eNSP 的自动化工具。生成拓扑、启动设备、按顺序下发配置，并在每条命令后核对结果。

提供三种调用方式，共用同一套核心：

- CLI：适合脚本化批量操作
- MCP Server：接入 Claude Desktop、Cursor 等客户端
- DeepSeek Harness 插件：以模型工具的形式在会话内使用

## 功能

### 生成拓扑

生成 eNSP 可直接打开并正常显示的 `.topo` 文件。支持内置场景，也可自定义设备与链路。

机型与接口布局定义在 `src/core/models.mjs`，覆盖 16 个机型。解析拓扑时，端口名优先取自设备自身声明的 `<interface>` 块；同一型号在加装扩展卡后端口排布可能不同，声明块是唯一可靠依据。

```js
import { twoPcLab, writeTopology } from 'dsh-ensp'

await writeTopology('lab.topo', twoPcLab({ vlan: 10 }))
```

```js
import { buildTopology, autoLayout } from 'dsh-ensp'

const topo = autoLayout(
  buildTopology()
    .add('R1', 'AR2220', { x: 180, y: 120 })
    .add('R2', 'AR2220', { x: 460, y: 260 })
    .link('R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0')
    .finish()
)
```

拓扑格式有几处约束来自 eNSP 本身：接口分组必须与机型一致，链路锚点必须落在图标包围盒内。任一项写错，eNSP 会打开空白画布且不报错。规则见 [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md)。

### 启动与停止设备

自动定位工具栏按钮，无需手动点击。启动后按设备逐一确认就绪，随后最小化窗口，桌面可继续使用。

```bash
ensp probe          # 重新标定按钮位置
ensp up lab.topo    # 打开、启动、确认就绪、最小化
ensp show           # 随时把窗口唤回前台
ensp stop           # 关闭全部设备
```

启动和下发配置期间窗口保持最小化，不抢前台。想看设备状态或手工改动时用 `ensp show` 唤回，改完再把它最小化即可，配置流程不受影响。这个命令只还原窗口并尝试置前，不触碰拓扑与设备状态。

eNSP 只允许运行一个实例。异常退出可能遗留不占线程的僵尸进程，该进程持续持有单实例锁，导致下一次启动只打开空白窗口。工具在启动前会识别并清理此类进程。

### 下发配置

逐条发送，每条命令确认提示符返回后才继续。提示符必须在本条命令的回显之后出现，否则视为上一条命令的输出尚未结束，不会据此判断视图。任一命令出错即中断，并回报行号、命令与设备原始输出。

设备回答“已存在”的行（`address already exists`、`VLAN already exists`、`route already exists` 等）视为已达目标状态，记为跳过而不是失败。改一行再重跑是最常见的用法，如果这些行一出现就中断，脚本永远跑不到真正改动的那一行。其他错误仍然中断，因为真正的拒绝通常意味着后面的行也会落到错误的对象上。

```js
import { pushConfig } from 'dsh-ensp'

const result = await pushConfig({
  device: 'SW1',
  port: 2000,
  script: `
    system-view
    vlan 10
     quit
    interface GigabitEthernet0/0/1
     port link-type access
     port default vlan 10
     quit
  `,
})

if (!result.ok) {
  console.log(result.failedAt.line, result.failedAt.command, result.failedAt.error)
}
```

### 等待协议收敛

路由协议异步收敛，配置下发完成不代表邻居已建立。此类判定一律轮询，直到状态达成或超时。

```js
import { waitForOspfFull, waitForOspfRoute, waitForOutput } from 'dsh-ensp'

await waitForOspfFull({ port: 2000, neighbourId: '2.2.2.2' })
await waitForOspfRoute({ port: 2000, prefix: '2.2.2.2/32' })
await waitForOutput({ port: 2000, command: 'display ip routing-table', until: /2\.2\.2\.2/ })
```

三个函数均返回 `{ ok, converged, output, attempts, waitedMs }`。固定等待在慢机器上会误判，在快机器上会浪费。

### 场景预设

内置 50 个场景，覆盖 VLAN、STP、堆叠、链路聚合、静态路由、RIP、OSPF、BGP、IS-IS、MPLS、组播、NAT、DHCP、ACL、QoS、端口安全、IPsec、IPv6、WLAN、防火墙与高可用等主题。

```bash
ensp preset                          # 按难度列出全部
ensp preset ospf-single              # 查看某个场景
ensp preset --search bgp             # 按关键词搜索
ensp preset campus-network --topo campus.topo   # 生成该场景的拓扑
```

每个场景提供三项信息：需要创建的对象、配置顺序、用于确认结果的检查命令。具体命令由使用者按设备补全。

场景自带拓扑蓝图：设备、链路、地址规划均为现成内容，加 `--topo` 即生成 eNSP 可打开的 `.topo`，无需先绘图再规划地址。

```bash
ensp preset ospf-single --topo ospf-single.topo
ensp up ospf-single.topo
```

地址规划也能直接变成命令。加 `--config` 输出该场景每台设备的接口与地址配置，范围仅限地址规划：路由协议、ACL、VRRP 这些仍是练习本身，场景不会代你写好。

```bash
ensp preset ospf-single --config                 # 按设备分段打印
ensp preset ospf-single --config ./configs       # 写成每台设备一个 .cfg，可直接交给 ensp apply
ensp preset ospf-single --config --json          # 打印模式下的同一份内容，便于脚本处理
```

50 个蓝图里 45 个带地址规划，五个二层场景（`vlan-access`、`trunk-interconnect`、`link-aggregation`、`port-security`、`port-isolation`）只有 VLAN 与端口，没有地址可配，`--config` 对它们报错而不是输出空脚本。

场景清单与蓝图均可生成、可校验。`docs/SCENARIOS.md` 由 `src/core/presets.mjs` 与 `src/core/labs.mjs` 渲染，`npm run docs:check` 在两者不一致时返回非零，CI 亦执行该检查。

### 教材章节索引

`src/core/curriculum.json` 记录厂商实验手册的章节结构：每章的学习目标、手册里用来证明结果的 `display` 命令，以及本章对应的内置场景。场景详情会附上对应章节，因此可以直接对照官方步骤检查自己的配置。

```bash
ensp preset ospf-lsa-types          # 详情里带「官方教材对应章节」小节
ensp preset --syllabus MPLS         # 按关键词检索章节索引
```

手册正文是厂商文档，不随包分发；索引只保留章名、目标与验证命令这些结构化事实。生成脚本读取抽取后的章节 JSON：

```bash
npm run curriculum -- <guides.json>
```

```bash
npm run docs          # 重新生成 docs/SCENARIOS.md
npm run docs:check    # 只检查是否过期
```

### 设备镜像检查

部分机型只有设备目录条目、没有随装镜像，最典型的是 `USG6000V`（eNSP 安装时需勾选该组件）。这类机型可以正常放入画布并保存为 `.topo`，但 eNSP 打开后会先渲染再自行退出，表现为控制台全部无响应。

`ensp up` 会在启动客户端之前读取 `res/items.xml` 与各插件的镜像文件，把无法启动的设备连同缺失项一并报出：

```console
$ ensp up firewall-hrp.topo
error: topology uses devices this eNSP installation cannot start:
  USG6000V (FW1, FW2): NGFW 镜像未安装（eNSP 安装时需勾选 USG6000V 组件）

This is not a bug in the topology: eNSP opens it, renders it, then quits. ...
```

`ensp preset ... --topo` 生成文件时给出同样的提示，`ensp_build_topology` 的返回值包含 `unsupportedDevices`。该检查只读取本机文件，不启动 eNSP。各场景的设备清单见 [docs/SCENARIOS.md](docs/SCENARIOS.md) 中的“设备镜像”一行。

镜像放在哪，由各机型的 VirtualBox 模板决定，不是一个固定位置。`ensp images` 逐个机型读出模板里的磁盘路径，再检查文件在不在：

```console
$ ensp images
USG6000V: missing E:\Huawei\eNSP\plugin\ngfw\DataBase\vfw_usg.vdi
NE40E: missing E:\Huawei\eNSP\plugin\ne\Database\NE40E.img
...
```

拿到镜像文件后，用一条命令放到这台机器该放的位置，同时把插件的 `system.ini` 指向它：

```console
$ ensp images USG6000V --install D:/downloads/vfw_usg.vdi
installed USG6000V → E:\Huawei\eNSP\plugin\ngfw\DataBase\vfw_usg.vdi (1429741568 bytes)
ImgFile updated in the plugin system.ini
restart eNSP if it is already running
```

目标路径从模板解析，换一台机器装在不同目录也照样正确。镜像不随包分发、也不会自动下载，来源是你手上已有的文件。只做检查不动文件时退出码为 1，方便写在启动脚本前面。

### 窗口遮挡检查

启动设备需要点击 eNSP 工具栏按钮，而合成点击由持有该像素的窗口接收。其他程序覆盖 eNSP 时，鼠标事件被该程序接收，eNSP 收不到任何输入。

插件在点击前通过 `WindowFromPoint` 检查落点归属，不属于 eNSP 则不执行点击：

```console
$ ensp up lab.topo
error: eNSP is covered by another window at 1307,426: vmware (unknown).
The mouse events would go to that window, so nothing was clicked.
Bring eNSP to the front (restore it from the taskbar) and try again.
```

标定前会以 5×4 采样网格检查窗口可见性，任一采样点被其他窗口占用即停止。标定读取屏幕像素，被遮挡时得到的是其他窗口的画面。点击完成后再次校验落点归属。

插件无法将 eNSP 窗口提到前台。Windows 仅允许持有前台权限的进程切换前台窗口，跨进程调用 `SetForegroundWindow` 会被拒绝。运行前请将 eNSP 置于最上层。

### 运行权限

本工具需要以管理员身份运行。

eNSP 客户端要求管理员权限，始终以高完整性级别运行。Windows 的用户界面特权隔离（UIPI）会丢弃低完整性进程发出的输入消息，模拟点击也在其中。普通权限下 `SendInput` 返回成功但输入队列不变，eNSP 收不到事件，表现为点击无效；以管理员身份启动后可正常注入输入。

管理员权限解决输入注入，不解决窗口置顶。eNSP 仍需保持可见并在最上层。

服务、计划任务、SSH 会话等非交互上下文不具备输入注入能力，提升权限也无法改变。`ensp doctor` 的 `input-injection` 项用于判定当前会话是否可用。

### 排错自检

启动失败时，定位故障项通常比修复本身更耗时。`ensp doctor` 将环境检查拆为七项，逐项判定，失败时给出可执行的修法：

```console
$ ensp doctor --topology lab.topo
[ok  ] ensp-installed: C:\Program Files\Huawei\eNSP\eNSP_Client.exe
[ok  ] virtualbox: C:\Program Files\Oracle\VirtualBox\VBoxManage.exe
[ok  ] console-ports: 2000-2100 free
[warn] memory: 949 MB free (each router needs ~256 MB)
       fix: Close some applications; devices may boot very slowly or fail to start.
[ok  ] device-images: AR2220 available
[FAIL] input-injection: SendInput accepted 2 event(s) but the session last-input tick did not change (session 1, console session 1)
       fix: Run the tool elevated (as administrator) from an interactive desktop session.
[ok  ] anchors: start (987,226) stop (1049,228)
```

该命令不启动 eNSP，只读取本机文件并执行一次合成输入探测，可在任意失败之后或操作之前运行。`--shallow` 跳过较慢的输入探测，`--json` 输出完整结构。对应工具为 `ensp_doctor`。

检查顺序固定：客户端可执行文件、VirtualBox、拓扑所需镜像、控制台端口、输入注入、内存、锚点。定位到哪一项失败，只需修复该项。

### 验收

配置下发成功不等于实验通过。`ensp_verify` 从 `.topo` 读取各设备的控制台端口，逐条执行该场景的验收命令，按输出内容判定，不依据命令是否报错：

```console
$ ensp verify ospf-single --topology lab.topo
ospf-single · 单区域 OSPF
[curated checks]
[pass] neighbour-full on R1: display ospf peer brief
[pass] ospf-route on R1: display ip routing-table protocol ospf

accepted: 2/2 checks passed
```

约 48 个场景配置了针对性断言（OSPF 需 `Full`、BGP 需 `Established`、VRRP 需 `Master`/`Backup`、MPLS VPN 需 `Established` 与 VPN 路由表）。这些场景的报告标 `[curated checks]`，每条检查都按输出内容判定。判定逻辑位于 `src/core/acceptance.mjs` 的 `EXPECTATIONS`，断言支持 `contains`、`notContains`、`matches`、`minLines`。对应工具为 `ensp_verify`，`ensp_scenario` 会标明某场景是否具有针对性断言。

其余 2 个场景没有断言，只执行场景内列出的验证命令。报告把这类检查标为 `[skip]`，结尾写 `unverified`，退出码为 3，不会计为通过：

```console
$ ensp verify firewall-hrp --topology lab.topo
firewall-hrp · 防火墙双机热备（HRP）
[smoke checks]
[skip] smoke-1 on FW1: display hrp state
         no assertion: this command only had to run
[skip] smoke-2 on FW1: display vrrp
         no assertion: this command only had to run
[skip] smoke-3 on FW1: display session table
         no assertion: this command only had to run

unverified: 3/3 checks had no assertion, 0 passed. Nothing contradicted the expected state, but no output was checked either.
```

断言中的设备名按设备族匹配到实际拓扑：蓝图使用 `R1`/`R2`，课程作业可能使用 `RA`/`RB`/`RC`，校验时取同一前缀族里的第 N 台（`R2` 取第二个 `R*`）。族里没有这个名字时报 `no console port for device "..."`，不会静默换成另一台设备。


断言不通过时会自动重试。路由协议在命令返回之后才收敛，`ensp apply` 结束后立即验收时，OSPF 邻居通常仍处于 `ExStart` 或 `2-Way`，单次采样会误判为失败。默认等待 60 秒，可通过 `--wait` 调整，通过时注明确切等待时长：

```console
$ ensp verify ospf-single --topology lab.topo
  checking neighbour-full on R1
  waiting 3s for neighbour-full on R1 (not contains "Full")
  ...
[pass] neighbour-full on R1: display ospf peer brief (converged after 27s)
```

以下两类失败不进入重试循环，重试不会改变结果：控制台不可达（设备未启动）与 VRP 拒绝命令（命令有误）。前者报告 `console unreachable: ... ECONNREFUSED`，后者报告 `VRP rejected the command`，均不伪装为断言不符。

推荐顺序为 `doctor`、`up`、`verify`：doctor 判定环境，up 判定设备，verify 判定配置效果。

### 实验报告

实验做完需要一个能交的文档时，`ensp report` 把这次运行的事实写成一份 Word 文档：

```console
$ ensp report ospf-single --topology lab.topo --out ospf-single.docx
collecting evidence for ospf-single from lab.topo
  checking neighbour-full on R1
  checking ospf-route on R1
wrote ospf-single.docx (7169 bytes)
verdict: passed (2 passed, 0 failed, 0 unverified of 2)
```

文档固定六章：实验目的、拓扑与地址规划、配置思路与命令、验证结果、问题与结论、附录。

内容全部来自这次运行，不是模板填空：

| 章节 | 来源 |
|---|---|
| 拓扑与地址规划 | 读 `.topo` 的设备、链路与控制台端口，地址表取自场景蓝图 |
| 配置思路与命令 | 每台设备执行 `display current-configuration`，收录设备上实际生效的配置 |
| 验证结果 | 重跑该场景的验收断言，把每条命令的完整输出原文抄进文档 |
| 问题与结论 | 场景的易错点，加上本次的验证结论 |

配置原文取自设备而不取下发过的 `.cfg` 文件：文件说的是打算配什么，设备说的是配成了什么，两者不一致时报告应当记录后者。

结论一章沿用验收的三态。验证通过写「验证通过」；有断言失败写「验证未通过」；场景没有断言时写「本次运行未验证」，并说明该章不能作为达标证明。`ensp report` 只在明确失败时以非零退出码结束，未验证按 0 返回，与 `ensp verify` 的退出码 3 区分开。

文档按需生成，工具不会在实验结束后自行产出文件。要写哪个实验的文档由你指定，对应工具为 `ensp_report`。

## 安装

### 作为 DSH 插件

在插件市场搜索 `dsh-ensp` 并安装，或：

```console
dsh plugin --profile desktop add dsh-ensp
```

### 作为 CLI 或库

```console
npm install -g dsh-ensp
ensp status
```

### 作为 MCP Server

```json
{
  "mcpServers": {
    "ensp": {
      "command": "npx",
      "args": ["-y", "dsh-ensp", "mcp"]
    }
  }
}
```

提供 17 个工具：`ensp_status`、`ensp_build_topology`、`ensp_open`、`ensp_start`、`ensp_stop`、`ensp_apply`、`ensp_apply_dir`、`ensp_query`、`ensp_probe`、`ensp_show`、`ensp_images`、`ensp_doctor`、`ensp_verify`、`ensp_report`、`ensp_scenarios`、`ensp_scenario`、`ensp_preset_config`。

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows。eNSP 仅有 Windows 版本，插件因此只声明 `win32` |
| eNSP | 已安装且可正常运行 |
| Node.js | 18 或更高版本 |
| DSH | 0.2.0 到 0.3.0 之前的版本（`engines.dsh` 决定兼容性） |
| 权限 | 以管理员身份运行本工具与 eNSP，两者需为同一权限级别 |

eNSP 与 VirtualBox 的安装位置自动探测：先看 `--exe` / `--vbox`，再看 `DSH_ENSP_EXE` / `DSH_VBOX` 环境变量，再看注册表，再看常见安装根目录与 `PATH`。注册表读的是安装程序实际写入的位置：eNSP 在卸载项 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\eNSP` 的 `InstallPath`，VirtualBox 在 `HKLM\SOFTWARE\Oracle\VirtualBox` 的 `InstallDir`。装在非默认盘符时不必手工配置，探测失败会列出每一个尝试过的位置及其来源。

系统缩放设为 125% 或 150% 时，程序会自行完成坐标换算，不需要手动调分辨率。若 eNSP 升级后按钮位置改变，执行 `ensp probe` 重新标定。

## 快速开始

在管理员身份下执行（见上文“运行权限”）：

```bash
ensp doctor                      # 先确认这台机器能跑起来
ensp preset ospf-single --topo lab.topo   # 生成拓扑
ensp up lab.topo                 # 启动设备
ensp apply ./configs --topology lab.topo --save
ensp verify ospf-single --topology lab.topo   # 按场景断言验收
ensp report ospf-single --topology lab.topo --out ospf-single.docx   # 产出实验报告
ensp stop
```

一次两级 OSPF 实验的完整耗时（本机实测，Windows 11、i5、系统缩放 150%）：

| 阶段 | 耗时 |
|---|---|
| 生成 `.topo` | 2s |
| 打开并渲染拓扑 | 14s |
| 两台 AR2220 启动到可登录 | 64s |
| 下发两侧各 9 条配置 | 8s |
| OSPF 邻居到 Full | 40s |

## 致谢与许可

### 开源协议

采用 [GPL-3.0-or-later](LICENSE)。

基于本项目修改并对外分发时，需要：

1. 保留 `LICENSE` 中的版权声明；
2. 在源码及随附文档中注明原项目名称 `dsh-ensp` 与仓库地址 <https://github.com/lizi600jin/dsh-ensp>；
3. 使所分发的作品同样以 GPL-3.0-or-later 授权。

仅自行使用而不对外分发时，上述要求不适用。

未选用 MIT 或 Apache-2.0，是因为两者允许二次修改后闭源，与二次修改亦须开源的要求不符。

### 致谢

- Huawei eNSP：仿真器本体。
- 在 issue 中反馈问题的使用者。

## 免责声明

本项目是一个自动化外壳，不包含 eNSP，也不包含任何华为软件或镜像。使用前请自行安装，并遵守华为的软件许可。

自动化操作图形界面存在固有风险，例如窗口被遮挡、eNSP 版本升级、系统缩放变化。建议先在非关键环境中验证。

## 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md) | `.topo` 格式规则 |
| [`docs/UI-ANCHORS.md`](docs/UI-ANCHORS.md) | 界面坐标与启动流程 |
| [`docs/SCENARIOS.md`](docs/SCENARIOS.md) | 场景预设说明 |
