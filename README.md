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

面向华为 eNSP 网络实验的自动化工具。它把搭建实验的完整流程串起来：生成拓扑文件、打开、启动设备、按顺序下发配置，并在每条命令执行后核对结果。

提供三种调用方式，共用同一套核心实现：

- CLI：`ensp up`、`ensp apply`、`ensp preset`，适合脚本化批处理。
- MCP Server：供 Claude Desktop、Cursor 等任意 MCP 客户端调用。
- DeepSeek Harness 插件：以模型工具的形式在会话内使用。

## 背景：eNSP 缺少自动化接口

eNSP 是华为官方的网络仿真器，但没有对外提供控制设备的接口。下面几种思路都经过实测，均不可行。

| 思路 | 实测结果 |
|---|---|
| 修改 `.topo` 中的 `bootmode=1` 让设备随拓扑自启 | 无效。拓扑打开后设备仍处于关闭状态 |
| 用 VBoxManage 直接启动虚拟机 | 虚拟机可以启动，但无法获得控制台。`AR_Base` 的 `uart1="off"`，控制台由虚拟机内的代理程序反连 eNSP 分配的 `-consoleip/-consoleport`，该端口只有客户端知道 |
| 连接 eNSP 的控制端口（65514、7301） | 拒绝连接，或协议未公开 |
| 向窗口发送 `WM_COMMAND` 模拟点击 | 盲扫命令 id 区间会导致 eNSP 崩溃 |
| 抓取窗口截图定位按钮 | 画布由 DirectX 渲染，`PrintWindow` 与 `WM_PRINT` 均返回全黑图像 |

结论是启动设备只能通过驱动图形界面完成。本项目解决了这一环，其余可以自动化的部分也做了实现。

## 功能

### 拓扑生成

从 eNSP 自带的 40 个样例拓扑中反推出完整的格式规则，记录在 [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md)。生成的文件可以被 eNSP 正常打开并正确显示。

```js
import { twoPcLab, writeTopology } from 'dsh-ensp'

const topo = twoPcLab({ vlan: 10, subnet: '192.168.10' })
await writeTopology('lab.topo', topo)
```

也可以从零构建：

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

### 启动与停止设备

工具栏按钮的位置通过颜色特征实时定位：绿色三角对应“开启设备”，红色方块对应“停止设备”。这一方式不依赖硬编码像素，更换 eNSP 版本、分辨率或 DPI 缩放后可以重新标定。

```
ensp probe          # 重新标定并列出所有候选位置
ensp up lab.topo    # 打开拓扑、标定、点击启动、逐台确认就绪、最小化窗口
```

就绪状态按设备逐一判定。每台设备独立轮询自身控制台端口，直到 VRP 返回提示符为止。实测同一批设备的启动耗时为 34 秒至 70 秒不等，采用固定等待时间必然出现偏早或偏晚的情况。

窗口在启动完成后自动最小化，桌面可立即使用；点击 eNSP 图标即可重新唤出。

### 配置下发与校验

下发过程逐条进行，不在一次写入中塞入整段脚本：

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

// 失败时 result.ok 为 false，附带以下字段：
//   failedAt.line     行号
//   failedAt.command  出错的命令
//   failedAt.error    VRP 原始错误信息
//   failedAt.output   完整回显
```

实现遵循三条规则：

| 规则 | 依据 |
|---|---|
| 每条命令等到提示符返回后才发送下一条 | 若连续写入，错误会堆叠在一起，首个原因被掩盖 |
| 任一命令出错即中断整批 | 后续命令通常连锁失败，只会增加噪声 |
| 视图层级由提示符判断 | 多执行一次 `quit` 会使后续命令全部落入错误的视图 |

### 场景预设

内置 23 个配置场景，覆盖 eNSP 官方 40 个实验的核心内容，并包含本项目实测验证的 IS-IS 多级别配置。

```bash
ensp preset                      # 按难度列出全部场景
ensp preset ospf-single          # 查看指定场景的配置方向
ensp preset --search bgp         # 按关键词搜索
```

每个场景提供三项信息，不含可直接执行的完整命令块：

1. 需要创建的对象，例如 VLAN、区域、邻居、地址池。
2. 配置顺序。VRP 对引用顺序敏感，这一项最容易出错。
3. 用于确认结果的 `display` 命令。

不提供命令模板，是因为照抄命令块会带来本项目要解决的若干失败情形。反掩码写成子网掩码、在系统视图中重复执行 `system-view`、给只有三个端口的 AR2220 配置 `GE0/0/3`，这些操作都不会报错，只会静默失效。给出骨架与验证命令，由使用者补全少量具体命令，通常更快也更准确。

## 安装

### 作为 DSH 插件

```console
dsh plugin --profile desktop add dsh-ensp
```

也可以在 DSH 插件市场中搜索 `dsh-ensp`。

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

共暴露 12 个工具：`ensp_status`、`ensp_build_topology`、`ensp_open`、`ensp_start`、`ensp_stop`、`ensp_apply`、`ensp_apply_dir`、`ensp_query`、`ensp_probe`、`ensp_scenarios`、`ensp_scenario`、`ensp_preset_config`。

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows。eNSP 仅有 Windows 版本 |
| eNSP | 已安装且可正常运行，需要管理员权限。客户端清单声明了 `requireAdministrator` |
| Node.js | 18 或更高版本 |
| 权限 | 插件与 eNSP 必须处于相同权限级别。跨完整性级别时无法枚举到 eNSP 窗口 |

若 DSH 未以管理员身份运行，`ensp up` 会明确报告权限不足。

## 快速开始

```bash
# 1. 查看场景方向，并生成一个两台 PC 加一台交换机的实验
ensp preset vlan-access
node -e "import('dsh-ensp').then(async m => {
  await m.writeTopology('lab.topo', m.twoPcLab())
})"

# 2. 打开并启动
ensp up lab.topo

# 3. 查看设备状态
ensp status --topology lab.topo

# 4. 下发配置
ensp apply ./configs --topology lab.topo --save
```

## 实现说明

以下问题在开发过程中实际出现过，记录于此以便后续维护。

### DPI 缩放会破坏坐标一致性

在 150% 缩放下，同一个窗口存在两套坐标：

| 调用方式 | 坐标系 | 同一窗口的取值 |
|---|---|---|
| 未声明 DPI 感知的 `GetWindowRect` | 逻辑坐标（已缩放） | 213,133，尺寸 1280×800 |
| 调用 `SetProcessDPIAware()` 之后 | 物理坐标 | 320,200，尺寸 1920×1200 |
| `CopyFromScreen` | 始终为物理像素 | 图像尺寸 1920×1200 |

混用会导致每次点击偏移 1.5 倍，表现为“点击无反应”。本项目全程使用物理坐标，且 `SetProcessDPIAware()` 必须在所有测量之前调用。

### `<interface>` 分组必须与 eNSP 一致

AR2220 的接口需要声明为两组：

```xml
<interface sztype="Ethernet" interfacename="GE" count="1" />   <!-- GE0/0/0 -->
<interface sztype="Ethernet" interfacename="GE" count="2" />   <!-- GE0/0/1~2 -->
```

若合并为一个 `count="3"`，eNSP 打开后画布为空，且不产生任何错误提示。

### PC 的接口名在文件与命令行中不一致

拓扑文件中写作 `interfacename="GE"`，命令行中对应 `Ethernet0/0/1`。

### 正则单词边界对 `GigabitEthernet0` 不成立

`GigabitEthernet` 与紧随的 `0` 均为单词字符，两者之间不存在单词边界，`\b` 断言因此失败且不报错，进而导致主机名解析错误和视图判断错误。

### 视图切换存在竞态

执行 `interface GigabitEthernet0/0/2` 后立即发送下一条命令时，设备可能尚未完成视图切换，该命令会被丢弃。需要等该命令本身回显之后，才能确认切换完成。

## 致谢与许可

### 开源协议

本项目采用 [GPL-3.0-or-later](LICENSE)，即 GNU General Public License 第 3 版或更新版本。

该协议与发布者的意愿对应如下：

| 期望 | GPL-3.0 的对应条款 |
|---|---|
| 允许任何人修改 | 第 2 条，可自由修改与分发 |
| 二次分发时注明原作者 | 第 5 条要求保留版权声明；本项目另依据第 7(b) 条增加署名要求 |
| 二次修改的作品同样开源 | 第 5 条，衍生作品须以同一协议发布 |

基于本项目修改并对外分发时，需要做到三点：

1. 保留 `LICENSE` 中的版权声明。
2. 在源码及随附文档中注明原项目名称 `dsh-ensp` 与仓库地址 <https://github.com/lizi600jin/dsh-ensp>。
3. 使所分发的作品同样以 GPL-3.0-or-later 授权。

仅自行使用而不对外分发时，上述要求不适用。

未选用 MIT 或 Apache-2.0 的原因在于，这两者允许二次修改后闭源，与“二次修改也须开源”的意愿冲突。

### 致谢

- Huawei eNSP：仿真器本体。本项目的格式规则均来自对其自带 40 个样例拓扑的分析。
- 在 issue 中反馈问题的使用者。

## 免责声明

本项目是一个自动化外壳，不包含 eNSP，也不包含任何华为软件或镜像。使用前请自行安装，并遵守华为的软件许可。

自动化操作图形界面存在固有风险，例如窗口被遮挡、eNSP 版本升级、系统缩放变化。插件在检测到异常时会明确报错，但仍建议先在非关键环境中验证。

## 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md) | `.topo` 格式的完整规则，基于 40 个样例统计得出 |
| [`docs/UI-ANCHORS.md`](docs/UI-ANCHORS.md) | 界面坐标、DPI 处理与启动流程 |
| [`docs/SCENARIOS.md`](docs/SCENARIOS.md) | 23 个场景预设的详细说明 |
| [`scripts/survey-topologies.mjs`](scripts/survey-topologies.mjs) | 重新统计样例格式，供 eNSP 升级后核对 |
