<p align="center">
  <strong>中文</strong>
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

拓扑格式有几处约束来自 eNSP 本身：接口分组必须与机型一致，链路锚点必须落在图标包围盒内。写错任意一项，eNSP 会打开一个没有任何设备的空白画布，并且不报错。规则见 [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md)。

### 启动与停止设备

自动定位工具栏按钮，无需手动点击。启动后按设备逐一确认就绪，窗口随即最小化，桌面可继续使用。

```bash
ensp probe          # 重新标定按钮位置
ensp up lab.topo    # 打开、启动、确认就绪、最小化
ensp stop           # 关闭全部设备
```

eNSP 只允许运行一个实例，异常退出时可能留下不占线程的僵尸进程，它会一直持有这个单实例锁，使下一次启动打开空白窗口。工具在启动前会识别并清理这种进程。

### 下发配置

逐条发送，每条命令确认提示符返回后才继续。任一命令出错即中断，并回报行号、命令与设备原始输出。

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

路由协议是异步收敛的，配置下发完不代表邻居已经建立。这类断言一律走轮询，直到状态达成或超时。

```js
import { waitForOspfFull, waitForOspfRoute, waitForOutput } from 'dsh-ensp'

await waitForOspfFull({ port: 2000, neighbourId: '2.2.2.2' })
await waitForOspfRoute({ port: 2000, prefix: '2.2.2.2/32' })
await waitForOutput({ port: 2000, command: 'display ip routing-table', until: /2\.2\.2\.2/ })
```

三个函数都返回 `{ ok, converged, output, attempts, waitedMs }`。固定等待一段时间再查询，在慢机器上会误判为失败，在快机器上纯属浪费。

### 场景预设

内置 50 个场景，覆盖 VLAN、STP、堆叠、链路聚合、静态路由、RIP、OSPF、BGP、IS-IS、MPLS、组播、NAT、DHCP、ACL、QoS、端口安全、IPsec、IPv6、WLAN、防火墙与高可用等主题。

```bash
ensp preset                          # 按难度列出全部
ensp preset ospf-single              # 查看某个场景
ensp preset --search bgp             # 按关键词搜索
ensp preset campus-network --topo campus.topo   # 生成该场景的拓扑
```

每个场景给出三项信息：需要创建的对象、配置顺序、用于确认结果的检查命令。具体命令由使用者按设备补全。

场景自带拓扑蓝图：设备、链路、地址规划都是现成的，加上 `--topo` 就直接得到一个 eNSP 能打开的 `.topo`，不用先自己画图再算 IP。蓝图不含配置命令，场景仍然只是骨架。

```bash
ensp preset ospf-single --topo ospf-single.topo
ensp up ospf-single.topo
```

场景清单与蓝图都是可生成、可校验的。`docs/SCENARIOS.md` 由 `src/core/presets.mjs` 与 `src/core/labs.mjs` 渲染而来，`npm run docs:check` 在两者不一致时返回非零，CI 也会执行这一步。

```bash
npm run docs          # 重新生成 docs/SCENARIOS.md
npm run docs:check    # 只检查是否过期
```

### 设备镜像检查

部分机型只有设备目录条目、没有随装镜像，最典型的是 `USG6000V`（eNSP 安装时需勾选该组件）。这类机型放上画布、存成 `.topo` 都没问题，但 eNSP 打开后会先渲染再自行退出，事后只能看到一堆“控制台无响应”，很容易误判成拓扑或插件的问题。

`ensp up` 启动客户端之前会读 `res/items.xml` 与各插件的镜像文件，把启动不了的设备连同缺什么一起报出来：

```console
$ ensp up firewall-hrp.topo
error: topology uses devices this eNSP installation cannot start:
  USG6000V (FW1, FW2): NGFW 镜像未安装（eNSP 安装时需勾选 USG6000V 组件）

This is not a bug in the topology: eNSP opens it, renders it, then quits. ...
```

`ensp preset ... --topo` 生成文件时也会给出同样的提示，`ensp_build_topology` 的返回值里带 `unsupportedDevices`。检查只读本机文件，不启动 eNSP。设备清单见 [docs/SCENARIOS.md](docs/SCENARIOS.md) 每个场景的“设备镜像”一行。

### 窗口遮挡检查

启动设备只能点 eNSP 的工具栏按钮，而合成点击落在**拥有那个像素的窗口**上。别的程序盖住 eNSP 时，鼠标事件全被它接走，eNSP 一条都收不到，结果就是报了一连串成功、然后等一批从未启动的设备。

插件在点击前用 `WindowFromPoint` 查落点属主，不是 eNSP 就不点，直接报：

```console
$ ensp up lab.topo
error: eNSP is covered by another window at 1307,426: vmware (unknown).
The mouse events would go to that window, so nothing was clicked.
Bring eNSP to the front (restore it from the taskbar) and try again.
```

标定之前还会扫一张 5×4 的采样网格，任一采样点被外人占住就拒绝开始，因为标定量的是屏幕像素，被遮挡时量到的全是别人的画面。点击后再查一次，防止点击瞬间被抢。

插件不能自己把 eNSP 提到前台，这一点值得说清楚，因为它决定了你该怎么用。eNSP 的 exe 要求管理员权限，所以它总以 High 完整性级别运行；普通进程属于 Medium，Windows 的 UIPI 会拦下所有发往高完整性窗口的输入消息（`WM_LBUTTONDOWN` 返回 `err=5`）。提到 High 之后 UIPI 放行，但 Windows 的前台锁仍然不允许一个后台进程改前台（`SetForegroundWindow` 返回 `False`，`AttachThreadInput` 被拒）。两条路都堵着，所以 eNSP 必须由你保持在最上层，并且你在那个桌面上。

还有一点：**不要用管理员身份运行本工具**。提权只让 `PrintWindow` 能拍到画布，点击照样进不去，还多过一次 UAC。

还有一种情况既不是遮挡也不是坐标：某些执行上下文（服务、计划任务、SSH 会话、agent 沙箱）根本没有输入注入能力。`SendInput` 会被接受并返回成功，但 `GetLastInputInfo` 的 tick 不动，窗口一个事件都收不到。`ensp doctor` 会实测这一点，见下节。

### 排错自检

启动失败时最费时间的不是修，而是判断该修哪里。`ensp doctor` 把“这台机器能不能跑起来”拆成七项逐条检查，每一项都能独立判定，失败时给一句能照做的修法：

```console
$ ensp doctor --topology lab.topo
[ok  ] ensp-installed: E:\Huawei\eNSP\eNSP_Client.exe
[ok  ] virtualbox: E:\VirtualBox\VBoxManage.exe
[ok  ] console-ports: 2000-2100 free
[warn] memory: 949 MB free (each router needs ~256 MB)
       fix: Close some applications; devices may boot very slowly or fail to start.
[ok  ] device-images: AR2220 available
[FAIL] input-injection: SendInput accepted 2 event(s) but the session last-input tick did not change (session 1, console session 1)
       fix: This session cannot deliver mouse input, so the eNSP toolbar button can never be
            pressed. Run the tool from an interactive desktop session ...
[ok  ] anchors: start (987,226) stop (1049,228)
```

它不启动 eNSP，只读本机文件并做一次合成输入探测，所以可以在任何失败之后、任何操作之前随手跑。`--shallow` 跳过较慢的输入探测，`--json` 输出完整结构。对应的工具是 `ensp_doctor`。

判断顺序是固定的：exe 在不在 → VirtualBox 在不在 → 这个拓扑要的镜像齐不齐 → 控制台端口空不空 → 输入能不能进去 → 内存够不够 → 锚点合不合理。卡在哪一项，就只修那一项。

### 验收

配置下发成功不等于实验成功。`ensp_verify` 读 `.topo` 拿到每台设备的控制台端口，逐条执行该场景的验收命令，按输出内容判定，而不是看命令有没有报错：

```console
$ ensp verify ospf-single --topology lab.topo
ospf-single — 单区域 OSPF
(curated checks)
[pass] neighbour-full on R1: display ospf peer brief
[pass] ospf-route on R1: display ip routing-table protocol ospf

accepted: 2/2 checks passed
```

约 30 个场景有专门写的断言（OSPF 要 `Full`、BGP 要 `Established`、VRRP 要有 `Master`/`Backup`、MPLS VPN 要有 `Established` 与 VPN 路由表），其余场景回退成“把场景里提到的验证命令都跑一遍”的冒烟检查。判定逻辑在 `src/core/acceptance.mjs` 的 `EXPECTATIONS`，断言支持 `contains`、`notContains`、`matches`、`minLines`。对应的工具是 `ensp_verify`，`ensp_scenario` 会告诉某个场景有没有专门断言。

断言不通过时会自己重试，因为路由协议是在命令返回之后才收敛的。`ensp apply` 一结束就验收，OSPF 邻居通常还在 `ExStart` 或 `2-Way`，只取一次快照会把它报成坏的实验。默认给 60 秒（`--wait` 改），通过时会注明等了多久：

```console
$ ensp verify ospf-single --topology lab.topo
  checking neighbour-full on R1
  waiting 3s for neighbour-full on R1 (not contains "Full")
  ...
[pass] neighbour-full on R1: display ospf peer brief (converged after 27s)
```

两类失败不进重试循环，因为等下去也不会变好：控制台连不上（设备没启动）和 VRP 拒绝命令（命令写错）。前者直接说 `console unreachable: ... ECONNREFUSED`，后者说 `VRP rejected the command`，都不会伪装成“断言不符”。

用法上先 `doctor` 再 `up` 再 `verify`：doctor 回答环境行不行，up 回答设备起没起，verify 回答网络通不通。

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

提供 14 个工具：`ensp_status`、`ensp_build_topology`、`ensp_open`、`ensp_start`、`ensp_stop`、`ensp_apply`、`ensp_apply_dir`、`ensp_query`、`ensp_probe`、`ensp_doctor`、`ensp_verify`、`ensp_scenarios`、`ensp_scenario`、`ensp_preset_config`。

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows。eNSP 仅有 Windows 版本 |
| eNSP | 已安装且可正常运行，需要管理员权限 |
| Node.js | 18 或更高版本 |
| 权限 | 插件与 eNSP 需处于相同权限级别 |

系统缩放设为 125% 或 150% 时，程序会自行完成坐标换算，不需要手动调分辨率。若 eNSP 升级后按钮位置改变，执行 `ensp probe` 重新标定。

## 快速开始

```bash
ensp doctor                      # 先确认这台机器能跑起来
ensp preset ospf-single --topo lab.topo   # 生成拓扑
ensp up lab.topo                 # 启动设备
ensp apply ./configs --topology lab.topo --save
ensp verify ospf-single --topology lab.topo   # 按场景断言验收
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

未选用 MIT 或 Apache-2.0，是因为这两者允许二次修改后闭源，与"二次修改也须开源"的意愿冲突。

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
