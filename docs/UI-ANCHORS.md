# eNSP 界面锚点（实测记录）

> **坐标约定**：优先使用 **window-relative**（相对 eNSP 主窗口左上角），窗口移动后无需重测。
> 测量环境：Windows 1707×1067 桌面 / eNSP 客户区 1280×800 / 中文界面。
> 换分辨率或 eNSP 版本后请重跑 `npm run probe` 重新测量，**不要硬编码沿用旧值**。

## 主窗口定位

| 项 | 值 | 说明 |
|---|---|---|
| 窗口类名 | `Afx:00400000:b:00010003:00000006:*` | MFC 框架，末尾数字随实例变化 |
| 标题 | `eNSP_Client` | **会随打开的拓扑变化，不能作为定位依据** |
| 定位方式 | **按进程 PID 枚举 top-level 窗口，筛 class 前缀 `Afx:` 且宽度 > 200** | 实测最稳 |

> ⚠️ `FindWindowW(None, 'eNSP_Client')` 在 eNSP 打开拓扑后**可能返回 0 或返回别人的窗口**，
> 因为标题变了。必须走 PID 枚举。

## 工具栏按钮

### 已确认（2026-11-10 实测）

| 按钮 | window-relative | 屏幕绝对 | 识别特征 |
|---|---|---|---|
| **开启设备（Start All Device）** | **(660, 59)** | (873, 192) | 绿色实心三角；悬停 tooltip 显示“开启设备” |
| **关闭设备（Shutdown All Device）** | **(699, 55)** | (912, 188) | 红色实心方块；紧邻绿色三角右侧 |
| 保存 | (494, 59) | (707, 192) | 绿/黄软盘图标 |
| 1:1 缩放 | (846, 59) | (1059, 192) | 蓝框内 “1:1” |

> 两个键的 y 值略有差异（59 vs 55），因为测量时窗口位置有小幅变化；实际点击任一点都能命中，
> 图标本身约 16×16，容许 ±5 px 误差。插件内默认使用 (660,59) / (701,59)。

> **绿色三角的像素判据**：`g >= 90 && g-r >= 35 && g-b >= 25`，
> 在工具栏带（window-relative y∈[45,75]）内形成一个约 14×16 的连通块。
> 用它做**二次定位**比纯坐标可靠：坐标随分辨率变化，颜色特征不会。

### 工具栏带（window-relative）

- y 轴：图标中心约 **y = 59**；整个工具栏带大约 `y ∈ [40, 80]`
- x 轴：从约 60 开始，按钮间距约 41 px
- 判据：全屏截图里 eNSP 客户区顶部第一个图标行的中线

## 启动设备的正确流程（实测结论）

```
1. 打开拓扑：eNSP_Client.exe "<abs path>.topo"     # 命令行参数可用
2. 等窗口出现（约 25~40s；判据 = 能按 PID 枚举到宽度>200 的 Afx 窗口）
3. SetForegroundWindow + BringWindowToTop，等 1.2s
4. 点击「开启设备」＝ window-relative (660, 59)
5. 判定启动成功：Get-NetTCPConnection 出现 2000..2100 的监听端口
   （AR1220 约 60~120s；这不是“进程在不在”，是唯一可靠判据）
6. SW_MINIMIZE 最小化，并把激活交还给最小化之前的那个窗口
```

最小化只改窗口状态，不转移激活。`ShowWindow(h, SW_MINIMIZE)` 之后窗口已经 iconic，
但 `GetForegroundWindow()` 仍然是 eNSP；此时从任务栏点它，第一击会被 Windows 当成
“修正激活一致性”吞掉，表现为点了没反应、要再点一次。因此最小化后必须显式
`SetForegroundWindow(previousForeground)`，并在 120ms 后回读确认。
停止设备同理：点击需要 eNSP 在前台，但用户要的是停止，操作结束后不该把 eNSP 留在前台。

### 关键纠正（都来自实测，推翻了早期假设）

| 早期假设 | 实测结论 |
|---|---|
| 需要先 Ctrl+A 全选设备再点启动 | **不需要**；直接点「开启设备」即可启动全部 |
| 绿色三角在 window-relative (1099,151) | **错**，那是缩放/其他按钮；正确是 **(660,59)** |
| `.topo` 里 `bootmode="1"` 会开机自启 | **不会**；改 1 后打开拓扑，`list runningvms` 仍为空 |
| 可以用 VBoxManage 直接启设备 | **不可行**；`AR_Base` 的 `uart1="off"`，控制台不走串口，而是 guest 内代理反连 `-consoleip/-consoleport` |
| 可以暴力扫描 `WM_COMMAND` id 找启动 | **禁止**；eNSP 会直接崩死。工具栏无稳定可枚举 ID，只能真实鼠标点击 |
| 窗口在后台也能点 | **不可**；遮挡/最小化状态下驱动会让进程退出。必须先置前、操作完再最小化 |
| `FindWindowW('eNSP_Client')` 可定位 | **不可靠**；标题随拓扑变化，改拓扑后取不到 |

## 遮挡是硬失败，不是可重试的小问题

合成点击落在**拥有那个像素的窗口**上，不是落在预期窗口上。别的程序覆盖 eNSP 时，
鼠标事件由该程序接收，eNSP 收不到任何输入；而调用链每一步都会报告成功，调用方随后等待一批从未启动的设备。
因此遮挡按硬失败处理，不做重试。

所以插件在**点击前**先用 `WindowFromPoint` + `GetAncestor(GA_ROOT)` 查落点属主：

- 属主 PID ≠ eNSP PID → 不点击，抛错并点名挡路进程（`eNSP is covered by vmware (unknown) at 1307,426 ...`）
- `startAllDevices` 在标定之前还会用一张 5×4 的采样网格扫整个窗口；只要有任何一点被外人占住就拒绝开始，
  因为标定是**拍照**，被遮挡时量出来的是别人的像素，锚点全错
- 点击之后会再查一次属主（`STOLEN` 情形），防止点击瞬间被抢走

### 为什么不能自动置顶

这里有两层独立的拦截，缺一层都解释不通实测结果。

**第一层：UIPI。** eNSP 的 exe 内嵌 manifest 写死 `<requestedExecutionLevel level="requireAdministrator">`，
所以它总以 **High 完整性**运行；普通 shell 是 **Medium**。Windows 的 UIPI 禁止低完整性进程向高完整性
窗口投递输入类消息，因此从 Medium 上下文：

| 调用 | 结果 |
|---|---|
| `SendMessage(hwnd, WM_MOUSEMOVE=0x200)` | `ret=0 err=5`（ERROR_ACCESS_DENIED） |
| `SendMessage(hwnd, WM_LBUTTONDOWN=0x201)` | `ret=0 err=5` |
| `PostMessage(hwnd, WM_MOUSEMOVE)` | `ok=False err=5` |
| `SendMessage(hwnd, WM_GETTEXT=0xD)` / `WM_NULL` | `err=0`（只读消息能过，输入消息被拦） |
| `ShowWindow` / `BringWindowToTop` / `SetWindowPos` | `err=5` |
| `GetCursorPos` / `SetCursorPos` | `err=203` |

**第二层：前台锁。** 用 `Start-Process -Verb RunAs` 提到 High 之后（本机 UAC 是
`ConsentPromptBehaviorAdmin=0`，提升不弹窗），UIPI 那层放行，`SendMessage` 的 errno 从 5 变成 183，
`BringWindowToTop` 返回 `True`。但前台窗口仍是其他进程，`SetForegroundWindow` 依然 `False`、
`SetCursorPos` 依然 `False`。原因是 Windows 的前台锁：只有持有前台权限的进程才能改前台，
从后台启动的进程没有该权限，`AttachThreadInput` 也拿不到（`attach=False err=5`）。

已排除“不同窗口站/桌面”：`GetProcessWindowStation()` = `WinSta0`、`GetThreadDesktop()` = `Default`、
`OpenInputDesktop(0,false,0x0001)` 返回的桌面名也是 `Default`；所有进程 `SessionId` 均为 1，
`WTSGetActiveConsoleSessionId()` 也是 1。也排除了 Job 限制：
`QueryInformationJobObject(JobObjectBasicUIRestrictions)` 返回 `flags=0x0`。

另一条路也堵着：`PrintWindow` 从 Medium 上下文返回全白（`ok=False`），从 High 上下文**能**拍到真画布
（这是唯一一处提权有实质收益的地方），但拍到画面不等于能把点击送进去。

结论：eNSP 窗口必须由用户自行保持在最上层，并且用户处于那个交互桌面。插件能做的是尽早、
明确、可操作地报错，而不是点空了继续等。这也是 `ensp up` 要求启动时短暂占用前台的原因。

提权的作用需要与置顶区分开。提到 High 不会让插件取得前台权限，`SetForegroundWindow` 仍然失败，
所以置顶问题必须由用户解决。但提权是输入注入的前提：Medium 上下文里 `SendInput` 虽然返回成功，
输入队列却不变，eNSP 收不到点击；以管理员身份运行后输入注入恢复正常。因此本工具需要以管理员身份运行。

## 设备控制台

| 项 | 值 |
|---|---|
| 协议 | TCP `127.0.0.1:<com_port>` |
| 端口来源 | `.topo` 每个 `<dev>` 的 `com_port` 属性 |
| 行结束符 | **只用 `\r`**（`\r\n` 多余的 LF 会被下一个 y/n 确认吞掉） |
| 提示符 | 用户视图 `<host>` / 系统视图 `[host]` / 子视图 `[host-xxx]` |
| 错误关键字 | `Error:` `Unrecognized` `Incomplete command` `Wrong parameter` `Too many` |

> 实测：`system-view` → `[R1]`，`interface GE0/0/0` → `[R1-GigabitEthernet0/0/0]`，
> `quit` → `[R1]`，再 `quit` → `<R1>`，错误命令返回 `Error:`。
> **提示符是判断视图层级的唯一可靠依据**，不要靠维护状态机计数。
