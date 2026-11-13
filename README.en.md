<p align="center">
  English | <a href="README.md">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ensp"><img alt="npm" src="https://img.shields.io/npm/v/dsh-ensp?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/dsh-ensp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-ensp?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/lizi600jin/dsh-ensp/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/lizi600jin/dsh-ensp?style=flat-square&color=eab308"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square"></a>
</p>

# dsh-ensp

Automation for Huawei eNSP. Generates topologies, starts devices, pushes configuration in order, and checks the result of every command.

Three calling modes share one core:

- CLI: scripted batch operation
- MCP server: for Claude Desktop, Cursor and similar clients
- DeepSeek Harness plugin: model tools inside a session

## Features

### Generate topologies

Writes `.topo` files that eNSP opens and renders correctly. Works with the built-in scenarios or with devices and links you define yourself.

Model and interface layouts live in `src/core/models.mjs` and cover 16 models. When parsing a topology, port names come from the device's own `<interface>` block first; the same model can have a different port layout after an expansion card is added, and that declaration is the only reliable source.

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

A few topology rules come from eNSP itself: interface groups must match the model, and link anchors must fall inside the icon bounding box. If any of them is wrong, eNSP opens a blank canvas and reports nothing. See [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md).

### Start and stop devices

Locates the toolbar buttons automatically, so nothing has to be clicked by hand. After starting, it confirms each device one by one, then minimises the window so the desktop stays usable.

```bash
ensp probe          # re-calibrate the button positions
ensp up lab.topo    # open, start, confirm each device, minimise
ensp stop           # shut every device down
```

eNSP allows only one instance. An abnormal exit can leave a zombie process with no threads, which keeps holding the single-instance lock and makes the next start open a blank window. The tool identifies and clears such processes before starting.

### Push configuration

Sends one command at a time and waits for the prompt after each. A prompt only counts once the echo of that command has arrived, so output still draining from the previous command cannot decide the current view. The first error aborts the batch and reports the line, the command and the device's raw output.

A line the device answers with "already exists" (`address already exists`, `VLAN already exists`, `route already exists` and similar) is recorded as skipped rather than failed. Editing one line and re-running is the common loop, and stopping on those lines means the script never reaches the line that actually changed. Every other error still aborts, because a genuine rejection usually means the following lines land on the wrong object.

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

### Wait for convergence

Routing protocols converge asynchronously, so a finished push does not mean neighbours are up. Such checks poll until the state is reached or the timeout expires.

```js
import { waitForOspfFull, waitForOspfRoute, waitForOutput } from 'dsh-ensp'

await waitForOspfFull({ port: 2000, neighbourId: '2.2.2.2' })
await waitForOspfRoute({ port: 2000, prefix: '2.2.2.2/32' })
await waitForOutput({ port: 2000, command: 'display ip routing-table', until: /2\.2\.2\.2/ })
```

All three return `{ ok, converged, output, attempts, waitedMs }`. A fixed sleep misjudges on a slow machine and wastes time on a fast one.

### Scenario presets

50 presets cover VLAN, STP, stacking, link aggregation, static routing, RIP, OSPF, BGP, IS-IS, MPLS, multicast, NAT, DHCP, ACL, QoS, port security, IPsec, IPv6, WLAN, firewalls and high availability.

```bash
ensp preset                          # list by difficulty
ensp preset ospf-single              # read one preset
ensp preset --search bgp             # search by keyword
ensp preset campus-network --topo campus.topo   # write that topology
```

Each preset provides three things: the objects to create, the configuration order, and the commands that confirm the result. The actual commands are filled in per device.

Presets ship with a topology blueprint: devices, links and addressing are ready, and `--topo` writes a `.topo` that eNSP opens, with no drawing or address planning needed. Blueprints contain no configuration commands, so a preset remains a skeleton.

```bash
ensp preset ospf-single --topo ospf-single.topo
ensp up ospf-single.topo
```

The preset catalogue and the blueprints are both generated and checked. `docs/SCENARIOS.md` is rendered from `src/core/presets.mjs` and `src/core/labs.mjs`; `npm run docs:check` returns non-zero when the two disagree, and CI runs the same check.

```bash
npm run docs          # regenerate docs/SCENARIOS.md
npm run docs:check    # check whether it is stale
```

### Knowledge points

A scenario gives direction, not commands, so the vocabulary of the lab has to come from somewhere. `src/core/knowledge.json` holds knowledge points filed by topic: each scenario ends with a few question-and-answer pairs on the same subject, covering things like which LSA belongs to which area, which attribute decides a BGP path, and which port role only MSTP has.

```bash
ensp preset ospf-lsa-types          # the detail ends with a knowledge section
ensp preset --knowledge LSA         # search the index by keyword
```

The points are grouped by topic by hand: each one is a checkable statement rather than a copied entry. The index keeps only the stem and the correct option text; the source material is not shipped.

### Manual chapter index

`src/core/curriculum.json` records the chapter structure of the vendor lab manuals: the learning goals of each chapter, the `display` commands the manual uses to prove the result, and the built-in scenario that covers the same ground. A scenario detail lists the matching chapters, so you can compare your configuration against the official steps.

```bash
ensp preset ospf-lsa-types          # the detail ends with a manual chapter section
ensp preset --syllabus MPLS         # search the chapter index by keyword
```

The manual text is vendor documentation and is not shipped; the index keeps only the structured facts. The generator reads extracted chapter JSON:

```bash
npm run curriculum -- <guides.json>
```

### Device image check

Some models have a catalogue entry without a shipped image, most notably `USG6000V` (its component has to be selected during eNSP installation). Such models can be placed on the canvas and saved to a `.topo`, but eNSP renders the topology and then quits, which shows up as consoles that never answer.

`ensp up` reads `res/items.xml` and the plugin image files before starting the client, and reports models that cannot start together with the missing piece:

```console
$ ensp up firewall-hrp.topo
error: topology uses devices this eNSP installation cannot start:
  USG6000V (FW1, FW2): NGFW 镜像未安装（eNSP 安装时需勾选 USG6000V 组件）

This is not a bug in the topology: eNSP opens it, renders it, then quits. ...
```

`ensp preset ... --topo` prints the same warning, and `ensp_build_topology` returns `unsupportedDevices`. The check only reads local files and does not start eNSP. Per-scenario device lists appear in [docs/SCENARIOS.md](docs/SCENARIOS.md) under the device image line.

### Window occlusion check

Starting devices requires clicking eNSP toolbar buttons, and a synthetic click goes to the window that owns that pixel. When another program covers eNSP, the mouse events go there and eNSP receives no input.

Before clicking, the tool checks the owner of the target point with `WindowFromPoint` and skips the click when the owner is not eNSP:

```console
$ ensp up lab.topo
error: eNSP is covered by another window at 1307,426: vmware (unknown).
The mouse events would go to that window, so nothing was clicked.
Bring eNSP to the front (restore it from the taskbar) and try again.
```

Calibration samples the window on a 5 by 4 grid and stops once any sample point belongs to another window. Calibration reads screen pixels, so an occluded window yields another program's pixels. After the click the owner is checked once more.

The tool cannot raise the eNSP window. Windows lets only the process holding foreground rights switch the foreground window, and a cross-process `SetForegroundWindow` is refused. Keep eNSP on top before running.

### Run permissions

This tool must run as administrator.

The eNSP client requires administrator rights and always runs at high integrity. Windows user interface privilege isolation (UIPI) drops input messages sent by lower-integrity processes, and synthetic clicks are among them. At normal privileges `SendInput` reports success but the input queue does not change, so eNSP receives nothing and clicks appear to do nothing. Started as administrator, input injection works.

Administrator rights solve input injection, not window stacking. eNSP still has to stay visible and on top.

Services, scheduled tasks and SSH sessions have no input-injection capability, and elevation does not change that. The `input-injection` check of `ensp doctor` reports whether the current session can be used.

### Doctor

When a start fails, locating the faulty item usually costs more than fixing it. `ensp doctor` splits the environment into seven checks, decides each one, and gives an actionable fix when one fails:

```console
$ ensp doctor --topology lab.topo
[ok  ] ensp-installed: E:\\Huawei\\eNSP\\eNSP_Client.exe
[ok  ] virtualbox: E:\\VirtualBox\\VBoxManage.exe
[ok  ] console-ports: 2000-2100 free
[warn] memory: 949 MB free (each router needs ~256 MB)
       fix: Close some applications; devices may boot very slowly or fail to start.
[ok  ] device-images: AR2220 available
[FAIL] input-injection: SendInput accepted 2 event(s) but the session last-input tick did not change (session 1, console session 1)
       fix: Run the tool elevated (as administrator) from an interactive desktop session.
[ok  ] anchors: start (987,226) stop (1049,228)
```

The command does not start eNSP; it reads local files and runs one synthetic input probe, so it can run after any failure or before any operation. `--shallow` skips the slower input probe and `--json` prints the full structure. The matching tool is `ensp_doctor`.

The check order is fixed: client executable, VirtualBox, topology images, console ports, input injection, memory, anchors. Fix only the item that fails.

### Verification

A successful push does not mean the lab works. `ensp_verify` reads console ports from the `.topo`, runs the verification commands of that scenario, and judges by output content rather than by whether the command reported an error:

```console
$ ensp verify ospf-single --topology lab.topo
ospf-single · 单区域 OSPF
[curated checks]
[pass] neighbour-full on R1: display ospf peer brief
[pass] ospf-route on R1: display ip routing-table protocol ospf

accepted: 2/2 checks passed
```

About 30 scenarios have targeted assertions (OSPF needs `Full`, BGP needs `Established`, VRRP needs `Master`/`Backup`, MPLS VPN needs `Established` and a VPN routing table); the rest fall back to running the verification commands listed in the scenario. The decision logic lives in `EXPECTATIONS` in `src/core/acceptance.mjs`, and assertions support `contains`, `notContains`, `matches` and `minLines`. The matching tool is `ensp_verify`, and `ensp_scenario` reports whether a scenario has targeted assertions.

Device names in assertions map by role to the topology you actually have: blueprints use `R1`/`R2` while course assignments may use `RA`/`RB`/`RC`. Verification takes the first device with a console (`R2` takes the second), so a different name does not change the result.

Failed assertions are retried automatically. Routing protocols converge after the command returns, and right after `ensp apply` an OSPF neighbour is usually still in `ExStart` or `2-Way`, so a single sample would report a working lab as broken. The default wait is 60 seconds, `--wait` changes it, and a pass records how long it actually waited:

```console
$ ensp verify ospf-single --topology lab.topo
  checking neighbour-full on R1
  waiting 3s for neighbour-full on R1 (not contains "Full")
  ...
[pass] neighbour-full on R1: display ospf peer brief (converged after 27s)
```

Two kinds of failure skip the retry loop because retrying changes nothing: an unreachable console (device not started) and a command VRP rejects (wrong command). The former reports `console unreachable: ... ECONNREFUSED`, the latter reports `VRP rejected the command`; neither is disguised as an assertion mismatch.

The recommended order is `doctor`, `up`, `verify`: doctor decides the environment, up decides the devices, verify decides the configuration effect.

## Installation

### As a DSH plugin

Search `dsh-ensp` in the plugin market and install it, or:

```console
dsh plugin --profile desktop add dsh-ensp
```

### As a CLI or library

```console
npm install -g dsh-ensp
ensp status
```

### As an MCP server

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

15 tools are provided: `ensp_status`, `ensp_build_topology`, `ensp_open`, `ensp_start`, `ensp_stop`, `ensp_apply`, `ensp_apply_dir`, `ensp_query`, `ensp_probe`, `ensp_doctor`, `ensp_verify`, `ensp_scenarios`, `ensp_scenario`, `ensp_knowledge` and `ensp_preset_config`.

## Requirements

| Item | Requirement |
|---|---|
| OS | Windows. eNSP has no other build, which is why the plugin declares `win32` only |
| eNSP | Installed and working |
| Node.js | 18 or newer |
| DSH | 0.2.0 up to but not including 0.3.0 (`engines.dsh` decides compatibility) |
| Privileges | Run both this tool and eNSP as administrator, at the same integrity level |

The eNSP and VirtualBox install locations are detected automatically: `--exe` / `--vbox` first, then the `DSH_ENSP_EXE` / `DSH_VBOX` environment variables, then the `HKLM\SOFTWARE\Huawei\eNSP` registry key, then the usual install roots and `PATH`. Nothing needs configuring when either is installed on another drive, and a failed lookup lists every location it tried together with where that location came from.

At 125% or 150% display scaling the tool converts coordinates itself, so no resolution change is needed. If an eNSP upgrade moves the buttons, run `ensp probe` to re-calibrate.

## Quick start

Run as administrator (see "Run permissions" above):

```bash
ensp doctor                      # confirm this machine can run a lab
ensp preset ospf-single --topo lab.topo   # write a topology
ensp up lab.topo                 # start the devices
ensp apply ./configs --topology lab.topo --save
ensp verify ospf-single --topology lab.topo   # verify against the scenario
ensp stop
```

Timing for one two-area OSPF lab (measured on Windows 11, i5, 150% scaling):

| Stage | Time |
|---|---|
| Write the `.topo` | 2s |
| Open and render the topology | 14s |
| Two AR2220 to a loginable prompt | 64s |
| Push 9 commands to each side | 8s |
| OSPF neighbours to Full | 40s |

## Thanks and licence

### Licence

[GPL-3.0-or-later](LICENSE).

Redistributing a modified version requires:

1. Keeping the copyright notice in `LICENSE`;
2. Naming the original project `dsh-ensp` and its repository <https://github.com/lizi600jin/dsh-ensp> in the source and the accompanying documentation;
3. Licensing the distributed work under GPL-3.0-or-later as well.

None of this applies when you use the project yourself without redistributing it.

MIT and Apache-2.0 were not chosen because both allow a modified version to be distributed closed source, which conflicts with the requirement that modifications also be published.

### Thanks

- Huawei eNSP: the simulator itself.
- The users who reported problems in issues.

## Disclaimer

This project is an automation shell. It contains neither eNSP nor any Huawei software or image. Install eNSP yourself and follow Huawei's licence terms.

Automating a graphical interface carries inherent risk, for example an occluded window, an eNSP upgrade or a change in display scaling. Validate in a non-critical environment first.

## Documentation

| Document | Content |
|---|---|
| [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md) | `.topo` format rules |
| [`docs/UI-ANCHORS.md`](docs/UI-ANCHORS.md) | Interface coordinates and startup flow |
| [`docs/SCENARIOS.md`](docs/SCENARIOS.md) | Scenario presets |
