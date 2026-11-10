# dsh-ensp

> 把华为 eNSP 网络实验从「手点 GUI」变成「一条命令」：生成拓扑、一键启停设备、逐条下发配置并精确定位错误。

[![npm version](https://img.shields.io/npm/v/dsh-ensp.svg)](https://www.npmjs.com/package/dsh-ensp)
[![CI](https://github.com/lizi600jin/dsh-ensp/actions/workflows/ci.yml/badge.svg)](https://github.com/lizi600jin/dsh-ensp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/dsh-ensp.svg)](https://nodejs.org)

`dsh-ensp` 是一套自动化 Huawei eNSP（Enterprise Network Simulation Platform）实验的工程工具。eNSP 官方没有开放 API，所有「把设备开起来」的路径最终都只能落到它的 GUI 上；这个项目把这段不可编程的部分封装成可编程、可复现、可测试的步骤。

---

## Features

- **拓扑生成与解析** — 读写 eNSP 原生 `.topo`（XML）文件：生成拓扑、解析设备与链路、把每台设备的 `com_port` 映射出来，供后续控制台直连使用。
- **一键启停设备** — 自动定位 eNSP 主窗口，按颜色特征标定工具栏按钮（绿色三角 = 开启设备，红色方块 = 停止设备），点击后**立即最小化窗口**，把桌面还给使用者。
- **逐条配置下发与错误定位** — 一次只发一条命令，等提示符回来再发下一条；任一错误立刻中断整批，回报 **行号 + 原始回显**，而不是继续制造几十条连锁失败。
- **就绪主动探测** — 每台设备独立轮询自己的控制台 TCP 端口，直到 VRP 真的回出提示符才算就绪；不用固定 `sleep`，慢设备不会被误判失败，快设备也不必空等。
- **视图层级校验** — 用提示符（而非计数器）判断当前处于用户视图 / 系统视图 / 子视图，`quit` 多退一层后会自动纠正，避免后续命令全部落在错误的视图里。

## Requirements

| 项 | 要求 |
|---|---|
| 操作系统 | **Windows**（驱动 GUI 依赖 Win32 API，仅 Windows 可用） |
| eNSP | Huawei eNSP 已安装，且 **以管理员身份运行**（否则虚拟网卡与设备启动会失败） |
| Node.js | **>= 18** |
| 虚拟化 | VirtualBox（eNSP 自带，一般无需单独安装） |
| 显示 | 任意 DPI；首次使用建议跑一次 `ensp probe` 标定 |

> **管理员权限**是硬性要求：eNSP 客户端本身需要提权才能创建虚拟网卡（VirtualBox Host-Only）并启动设备。请在「以管理员身份运行」的终端里执行 `ensp` 命令，或先手动以管理员身份启动 eNSP。

## Install

```bash
# 全局安装（推荐，直接获得 ensp 命令）
npm i -g dsh-ensp

# 或作为项目依赖
npm i dsh-ensp
```

全局安装后 `ensp` 即可用；作为依赖安装时可通过 `npx ensp` 调用，或在代码里 `import` 核心模块（见[三种用法](#三种用法)）。

## Quick start

```bash
# 1. 启动拓扑里的所有设备（自动标定工具栏 → 点击开启 → 最小化 → 逐台等就绪）
ensp up lab.topo

# 2. 下发配置（目录里每个 <设备名>.cfg 对应一台设备）
ensp apply ./configs --topology lab.topo

# 3. 看现在哪些设备在跑、哪些控制台能应答
ensp status --topology lab.topo

# 4. 换了 eNSP 版本或改了显示缩放后，重新标定按钮坐标
ensp probe
```

`ensp up` 的典型输出：

```
topology lab.topo
  4 devices, 3 links (AR2220×2, S5700×1, PC×1)
window hwnd=132456 (launched)
starting devices (per-device timeout 240s)
  toolbar anchors measured {"x":992,"y":84,"w":16,"h":16}
  ✓ AR1          console 2001 → <AR1> 34.2s
  ✓ AR2          console 2002 → <AR2> 41.7s
  ✓ LSW1         console 2003 → <LSW1> 48.1s
  window minimised — desktop handed back
all devices ready (3 new console ports)
```

### 配置目录约定

`ensp apply` 读取目录里所有 `.cfg` / `.txt` 文件，**文件名去掉扩展名就是设备名**，必须与 `.topo` 里的设备名一致：

```
configs/
├── AR1.cfg
├── AR2.cfg
└── LSW1.cfg
```

```text
! AR1.cfg —— 注释用 ! 或 #，空行忽略
sysname R1-TEST
interface GigabitEthernet0/0/0
 ip address 10.0.0.1 255.255.255.0
 quit
```

### 命令一览

| 命令 | 作用 |
|---|---|
| `ensp up <topo>` | 打开拓扑并启动全部设备，逐台验证就绪 |
| `ensp up <topo> --stop` / `ensp stop` | 停止全部设备（红色方块） |
| `ensp apply <dir> --topology <topo>` | 逐台下发配置；`--save` 下发后执行 `save`，`--device NAME` 只处理一台 |
| `ensp status [--topology <topo>]` | 显示 eNSP 进程 / 窗口 / 当前锚点，可选逐台检查控制台 |
| `ensp probe [--json]` | 只测量不点击，报告找到的绿色/红色按钮簇与解析结果 |

其他参数：`--keep-window`（点击后不最小化）、`--timeout MS`（单台就绪上限，默认 240000）。

退出码：`0` 成功，`1` 失败（有设备没就绪 / 配置出错），`2` 用法错误。

## 三种用法

### 1. CLI

见上文 [Quick start](#quick-start)。适合手工跑实验、写 shell 脚本，或放进任何能在 Windows 上执行命令的流水线。

### 2. MCP server

> 接口已预留（`src/mcp/server.mjs`），当前版本 **尚未实现**，v0.2 提供。

计划暴露为 MCP 工具的四个操作，与 CLI 一一对应：`ensp_up`、`ensp_apply`、`ensp_status`、`ensp_probe`。接入后可在 Claude Desktop、Cursor 等任意 MCP 客户端里用自然语言驱动实验，例如「把 lab.topo 的设备都起来，然后下发 configs 目录」。

### 3. DeepSeek Harness 插件

> 接口已预留（`src/dsh/index.mjs` + `cordis.patch.yml`），当前版本 **尚未实现**，v0.2 提供。

计划以 DSH 插件形态加载（`package.json` 已声明 `dsh.bundle.patch`），把同样的四个操作注册为 Agent 可调用的工具，让 Harness 直接编排「建拓扑 → 起设备 → 配 → 验证」的闭环。

### 附：编程接口

不经过 CLI，直接把核心模块嵌进自己的脚本：

```js
import { readTopology, summarise } from 'dsh-ensp/topology'
import { pushConfig } from 'dsh-ensp/provision'

const topo = await readTopology('lab.topo')
console.log(summarise(topo))            // { devices, links, consoles, byModel }

const r = await pushConfig({
  device: 'AR1',
  port: topo.devices.find((d) => d.name === 'AR1').comPort,
  script: 'sysname R1-TEST\ninterface LoopBack0\n ip address 1.1.1.1 255.255.255.255\n',
  save: false,
})
if (!r.ok) console.error(`第 ${r.failedAt.line} 行失败: ${r.failedAt.error}`)
```

可用的子路径导出：`dsh-ensp/core`、`/topology`、`/console`、`/launcher`、`/provision`。

## How it works

### 为什么必须驱动 GUI

启动设备在 eNSP 里**没有 API**。以下路径都经过实测并被否定：

| 尝试 | 结果 |
|---|---|
| 在 `.topo` 里写 `bootmode="1"` 期望自启 | **不成立**。改完后打开拓扑，`VBoxManage list runningvms` 仍为空，设备依旧停着 |
| 用 `VBoxManage startvm` 直接拉起虚拟机的克隆 | **不可行**。VM 能跑起来，但没有控制台：`AR_Base` 的 `uart1="off"`，控制台并不走虚拟串口 |
| 直连 eNSP 控制端口（65514 / 7301） | **不可用**。端口拒绝连接，协议未公开 |
| 盲扫 `WM_COMMAND` 消息 id 触发按钮 | **禁止**。会把 eNSP 直接搞崩，工具栏没有稳定可枚举的 id |

关键在于**控制台不是虚拟机的串口**：设备内的代理进程会反向连接到 eNSP 客户端分配的 `-consoleip/-consoleport` 对。也就是说，端口由客户端在启动设备时才分配，只有客户端能把设备「开起来」。所以唯一可靠的入口就是工具栏上那颗「开启设备」按钮——一次真实、像人手的鼠标点击。

### 坐标标定：150% DPI 的坑

这台机器是 **150% 缩放**，混用逻辑像素与物理像素会让每次点击整体偏移 1.5 倍，而且**看起来还挺像对的**：

| 调用点 | 坐标系 | 该窗口的值 |
|---|---|---|
| 未声明 DPI 感知时的 `GetWindowRect` | 逻辑（被缩放） | 213,133 / 1280×800 |
| `SetProcessDPIAware()` 之后的 `GetWindowRect` | 物理 | 320,200 / 1920×1200 |
| `CopyFromScreen` | 永远是物理像素 | 1920×1200 的截图 |

规则只有一条：**先 `SetProcessDPIAware()`，之后全程只用物理像素**。`GetWindowRect` / `SetCursorPos` / `CopyFromScreen` 三者必须在同一坐标系里，否则「测出来的 (1099,151)」看着合理，落点却在空白工具栏上。

按钮位置不靠硬编码，而是按**颜色特征**在工具栏带里找连通块：绿色三角（判据 `g >= 90 && g-r >= 35 && g-b >= 25`）是开启设备，紧邻其右侧的红色方块是停止设备。坐标会随分辨率、eNSP 版本变化，颜色特征不会。实测物理相对坐标 `(992,84)` / `(1047,86)`，窗口相对。

### 为什么不用固定等待

同类设备的启动时间实测从 **34 s 到 48 s** 不等，模型、镜像、宿主机负载都会影响。固定 `sleep` 只有两种结局：要么短了把还在启动的设备判死，要么长了白等。

所以每台设备**独立轮询自己的控制台 TCP 端口**：连上后发一个 `\r`，只有当 VRP 真的回出提示符（`<host>` / `[host]`）才认为就绪；到点还没回就如实报告「没就绪」，绝不假设它好了。整体超时只是一个宽裕的上限，不参与判定。

### 配置下发：像人一样敲

- **一条一条来**：不流水线发送，上一条的提示符回来才发下一条，错误永远不会跑到报告前面。
- **遇错即停**：VRP 拒绝一行后，后续通常也会连锁失败，多刷的报错只会把真正的原因埋掉。第一处失败带着行号、命令原文和终端回显返回。
- **视图读回来，不假设**：进入配置块前确认真的在系统视图；每块结束后重读提示符，如果某个 `quit` 多退了一层，会自动重新进入，而不是让余下整段脚本落错地方。
- **主机名可能带连字符**：`R1-TEST` 这样的名字会让「有没有 `-`」这种判据完全失效，所以子视图识别是拿提示符里的主机名做比对，而不是看标点。
- **只用 `\r` 换行**：`\r\n` 多出来的 LF 会被下一个 `[Y/N]` 确认吞掉，静默替用户答了默认值。

## Known limitations

- **仅 Windows + eNSP**。这不是实现取舍，而是 eNSP 本身只有 Windows 客户端，且唯一入口是 Win32 GUI。
- **启动设备时会短暂占用前台约 1–2 秒**。eNSP 在窗口被遮挡或最小化时驱动会直接退出，因此必须先置前、点击、再最小化。这段时间请不要抢焦点。
- **eNSP 升级或 DPI/分辨率变化后需要重新标定**：先让 eNSP 开着窗口，再跑 `ensp probe` 确认能找到绿色三角与红色方块。标定失败会退回默认锚点并在输出里标记为 `default`，此时点击可能落空。
- **控制台端口来自 `.topo` 的 `com_port`**。如果拓扑是用别的工具生成或手工改过，端口可能为空或过期，`status` 会显示 `not answering`。
- **需要管理员权限**。eNSP 以普通权限运行时，虚拟网卡创建会失败，表现为设备起不来而没有任何明显报错。
- **MCP server 与 DSH 插件仍在实现中**（见[三种用法](#三种用法)）。

## 开发

```bash
git clone https://github.com/lizi600jin/dsh-ensp.git
cd dsh-ensp
npm test        # node --test
```

源码结构：

```
src/
├── cli/ensp.mjs        # 命令行入口：up / apply / status / probe / stop
└── core/
    ├── topology.mjs    # .topo 读写、设备与链路解析、接口索引映射
    ├── launcher.mjs    # 进程/窗口定位、DPI 感知、工具栏点击、就绪轮询
    ├── calibrate.mjs   # 按颜色特征标定工具栏锚点
    ├── console.mjs     # VRP 控制台会话：提示符驱动的 exec / 视图判定
    └── provision.mjs   # 配置批处理：逐条下发、遇错即停、行号定位
docs/UI-ANCHORS.md      # 实测界面锚点记录与复测方法
```

修改坐标相关代码前请先读 [`docs/UI-ANCHORS.md`](docs/UI-ANCHORS.md)：里面记录了每个「看起来能跑其实在骗人」的坑。

## License

[MIT](LICENSE)
