# 场景预设（50 个）

由 `scripts/gen-scenarios-doc.mjs` 从 `src/core/presets.mjs` 与 `src/core/labs.mjs` 生成，勿手改。

每个场景只给**方向、顺序、验证命令**，不给成品命令块。

其中 50 个带拓扑蓝图，可直接生成 `.topo`：

```
ensp preset ospf-single --topo ospf-single.topo
ensp up ospf-single.topo
```

## 基础

### vlan-access — VLAN 与 Access 端口

- **英文名**：VLAN and access ports
- **来源**：eNSP HCNA Lab 1-2
- **设备**：1 台二层交换机 + 若干 PC
- **目标**：把不同端口划进不同 VLAN，同 VLAN 可通、跨 VLAN 不通

**配置顺序**

1. **创建 VLAN** — 按部门规划 VLAN ID，先创建再划端口
   - 验证：`display vlan`
2. **端口改为 access** — 每个接入口设置 link-type access 并指定 PVID
   - 验证：`display port vlan active`
3. **验证隔离** — 同 VLAN PC 互通；跨 VLAN 应不通（无需路由）

**易错点**

- 端口默认是 hybrid，直接设 PVID 不会让 VLAN 生效，必须先改 access
- trunk 口不要设 access，否则会把上行打断

**拓扑蓝图**

- 设备：SW1 (S5700)、PC1 (PC)、PC2 (PC)、PC3 (PC)
- 链路：3 条

生成：`ensp preset vlan-access --topo vlan-access.topo`

### trunk-interconnect — Trunk 互联与多 VLAN 透传

- **英文名**：Trunk interconnect
- **来源**：eNSP HCNA Lab 1-2 / 1-4
- **设备**：2 台交换机 + PC
- **目标**：跨交换机同 VLAN 通信，VLAN 通过 trunk 携带

**配置顺序**

1. **两端建同名 VLAN** — VLAN 必须两端都存在，否则帧被丢弃
   - 验证：`display vlan`
2. **互联口设 trunk** — 放行所需 VLAN；PVID 保持默认 1
   - 验证：`display port vlan active`
3. **接入口设 access** — 按 VLAN 划分

**易错点**

- trunk 未放行目标 VLAN 时静默丢帧，无报错
- PVID 与 access VLAN 混淆会导致本征 VLAN 错乱

**拓扑蓝图**

- 设备：SW1 (S5700)、SW2 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：3 条

生成：`ensp preset trunk-interconnect --topo trunk-interconnect.topo`

### vlanif-routing — VLAN 间路由（三层交换机）

- **英文名**：Inter-VLAN routing with a layer-3 switch
- **来源**：eNSP HCNA Lab 1-4 / 1-5
- **设备**：三层交换机 + PC
- **目标**：每个 VLAN 一个网关，VLAN 间可路由

**配置顺序**

1. **建 VLAN 与 access 端口** — 先二层通，再上三层
2. **创建 Vlanif 并配地址** — 一个 VLAN 一个 Vlanif，地址即该网段网关
   - 验证：`display ip interface brief`
3. **验证** — 不同 VLAN 的 PC 互 ping，网关应可达

**易错点**

- Vlanif 的 up 依赖该 VLAN 下至少一个 up 的端口
- 忘记给 PC 配网关则跨网段必然不通

**拓扑蓝图**

- 设备：SW1 (S5700)、SW2 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| SW1 | Vlanif10 | 192.168.10.254/24 | VLAN10 网关 |
| SW2 | Vlanif20 | 192.168.20.254/24 | VLAN20 网关 |
| SW1 | Vlanif200 | 10.0.12.1/24 | 互联 VLAN200 |
| SW2 | Vlanif200 | 10.0.12.2/24 | 互联 VLAN200 |

生成：`ensp preset vlanif-routing --topo vlanif-routing.topo`

### stp-rstp — STP / RSTP 生成树

- **英文名**：STP and RSTP
- **来源**：eNSP HCNA Lab 3-1 / 3-2
- **设备**：3 台交换机成环
- **目标**：破除二层环路，观察根桥、端口角色与收敛

**配置顺序**

1. **选根桥** — 核心设最低优先级，其余保持默认
   - 验证：`display stp`
2. **选择模式** — RSTP 收敛更快；MSTP 用于多实例场景
3. **观察端口角色** — 根端口 / 指定端口 / 阻塞端口
   - 验证：`display stp brief`
4. **断链验证** — 断一条链路，阻塞口应在数秒内转为转发

**易错点**

- 所有交换机优先级相同则靠 MAC 选根桥，结果不可控
- 边缘端口未开 edged-port 会让接终端时反复重收敛

**拓扑蓝图**

- 设备：SW1 (S5700)、SW2 (S5700)、SW3 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：5 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| SW1 | Vlanif10 | 192.168.10.251/24 | 管理地址 |
| SW2 | Vlanif10 | 192.168.10.252/24 | 管理地址 |
| SW3 | Vlanif10 | 192.168.10.253/24 | 管理地址 |

生成：`ensp preset stp-rstp --topo stp-rstp.topo`

### link-aggregation — 链路聚合 Eth-Trunk

- **英文名**：Link aggregation
- **来源**：eNSP 常规实验
- **设备**：2 台交换机 + 2 条互联线
- **目标**：多条物理链路聚合成一条逻辑链路，提高带宽并提供冗余

**配置顺序**

1. **建 Eth-Trunk** — 选 LACP 静态模式，两端必须一致
   - 验证：`display eth-trunk`
2. **加入成员口** — 成员口不能单独配 IP 或 VLAN
   - 验证：`display eth-trunk 1`
3. **在聚合口上配业务** — trunk / access 都配在 Eth-Trunk 上，不配在成员口

**易错点**

- 两端模式不一致（lacp-static vs manual）聚合不 up
- 成员口速率/双工不一致会只有部分成员 Selected

**拓扑蓝图**

- 设备：SW1 (S5700)、SW2 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：4 条

生成：`ensp preset link-aggregation --topo link-aggregation.topo`

### port-security — 端口安全与 MAC 限制

- **英文名**：Port security and MAC limits
- **来源**：eNSP 常规实验
- **设备**：1 台交换机 + 2 PC + 1 台非法终端
- **目标**：限制端口可学习的 MAC 数量，非法接入时丢包、告警或关闭端口

**配置顺序**

1. **开启端口安全** — 接口下 port-security enable，默认只允许 1 个 MAC
   - 验证：`display port-security`
2. **选择学习方式** — sticky 粘滞学习自动转成静态表项；或手工 mac-address static 绑定
3. **设违规动作** — protect 只丢包、restrict 丢包并告警、shutdown 直接关闭端口
4. **验证** — 换一台 PC 接入，观察丢包/告警/端口 down 是否符合预期

**易错点**

- 默认动作是 protect，只丢包不告警，容易误判为没生效
- 粘滞 MAC 已写入配置后换设备接入会学不到新 MAC，需先清 port-security mac-address sticky
- shutdown 动作需 error-down auto-recovery 或手工 undo shutdown 才能恢复

**拓扑蓝图**

- 设备：SW1 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：2 条

生成：`ensp preset port-security --topo port-security.topo`

### port-isolation — 端口隔离与 MUX VLAN

- **英文名**：Port isolation and MUX VLAN
- **来源**：eNSP 常规实验
- **设备**：1 台交换机 + 3 PC
- **目标**：同一 VLAN 内用户互不通信，但都能访问网关与服务器

**配置顺序**

1. **配端口隔离组** — 接入端口加入 port-isolate group，同组之间二层不通
   - 验证：`display port-isolate group`
2. **上行口与服务器口不入组** — 隔离只作用于同组端口，未入组的口仍可双向访问
3. **需要跨设备隔离时用 MUX VLAN** — principal VLAN 对接上行，separate VLAN 完全隔离，group VLAN 内互通
4. **验证** — 同组 PC 互 ping 不通，各自都能 ping 网关

**易错点**

- 端口隔离只在单台交换机内生效，跨设备要靠 VLAN 划分或 MUX VLAN
- MUX VLAN 中 separate 与 group 的语义容易配反，导致该通的通不了、该隔离的没隔离
- 把上行口也加进隔离组会切断所有人的网关访问

**拓扑蓝图**

- 设备：SW1 (S5700)、PC1 (PC)、PC2 (PC)、PC3 (PC)
- 链路：3 条

生成：`ensp preset port-isolation --topo port-isolation.topo`

### super-vlan — VLAN 聚合（Super-VLAN）

- **英文名**：Super-VLAN and sub-VLANs
- **来源**：eNSP 常规实验
- **设备**：1 台三层交换机 + PC
- **目标**：多个子 VLAN 共用一个网关地址，节省 IP 网段

**配置顺序**

1. **建子 VLAN** — 子 VLAN 只作二层划分，不建 Vlanif
2. **建 Super-VLAN 并关联子 VLAN** — aggregate-vlan 指定主 VLAN，access-vlan 列出子 VLAN
   - 验证：`display vlan`
3. **只在 Super-VLAN 上建 Vlanif** — 该地址同时是所有子 VLAN 的网关
4. **验证** — 不同子 VLAN 的主机同网段，可直接互通

**易错点**

- Super-VLAN 的 Vlanif 上不能再挂物理 access 口，否则冲突
- 给子 VLAN 也建 Vlanif 会直接报错或造成地址冲突
- Super-VLAN 本身不做隔离，需要隔离要再配合端口隔离

**拓扑蓝图**

- 设备：SW1 (S5700)、PC1 (PC)、PC2 (PC)、PC3 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| SW1 | Vlanif10 | 192.168.10.254/24 | super-VLAN 网关 |
| SW1 | Vlanif20 | 192.168.20.254/24 | sub-VLAN 20 |
| SW1 | Vlanif30 | 192.168.30.254/24 | sub-VLAN 30 |

生成：`ensp preset super-vlan --topo super-vlan.topo`

### static-route — 静态路由与默认路由

- **英文名**：Static and default routes
- **来源**：eNSP HCNA Lab 4-1
- **设备**：2~3 台路由器
- **目标**：手工打通非直连网段，并用默认路由简化边缘配置

**配置顺序**

1. **配接口地址** — 先保证直连可达
   - 验证：`display ip interface brief`
2. **写明细静态路由** — 目的网段 + 掩码 + 下一跳
   - 验证：`display ip routing-table`
3. **边缘用默认路由** — 0.0.0.0/0 指向出口，避免逐条写明细
4. **备份用浮动静态** — 同一目的写两条，备路由 preference 调高
   - 验证：`display ip routing-table protocol static`

**易错点**

- 下一跳必须直连可达，否则路由不进路由表（inactive）
- 掩码写错会让目的网段归一化成别的网段，形成意外覆盖或冲突

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、PC1 (PC)、PC2 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/1 | 192.168.1.254/24 | PC1 网关 |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | 互联 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | 互联 |
| R2 | GigabitEthernet0/0/1 | 192.168.2.254/24 | PC2 网关 |

生成：`ensp preset static-route --topo static-route.topo`

### rip — RIPv1 / RIPv2

- **英文名**：RIP versions 1 and 2
- **来源**：eNSP HCNA Lab 4-2 / 4-3
- **设备**：3 台路由器
- **目标**：用距离矢量协议自动学习路由；对比 v1 有类与 v2 无类的差别

**配置顺序**

1. **启动 RIP 进程** — 指定版本；v2 支持子网与认证
   - 验证：`display rip`
2. **network 宣告** — v1 按主类宣告，v2 可带掩码；宣告的是直连网段
3. **可选：认证与聚合** — v2 支持明文/MD5 认证和手动聚合
   - 验证：`display rip route`

**易错点**

- v1 不做子网掩码，遇到不连续子网会出错
- network 写错网段则接口不参与，邻居起不来

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、PC1 (PC)、PC2 (PC)
- 链路：4 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | 互联 R2 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 | 互联 R3 |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 |  |
| R1 | GigabitEthernet0/0/1 | 192.168.1.254/24 | PC1 网关 |
| R3 | GigabitEthernet0/0/1 | 192.168.3.254/24 | PC2 网关 |

生成：`ensp preset rip --topo rip.topo`

### ospf-single — OSPF 单区域

- **英文名**：OSPF single area
- **来源**：eNSP HCNA Lab 4-4
- **设备**：3~4 台路由器
- **目标**：单区域 OSPF 邻居建立与路由学习

**配置顺序**

1. **建 OSPF 进程** — 指定 router-id，建议显式配置避免选举不确定
   - 验证：`display ospf peer`
2. **area 0 内 network** — 宣告直连网段；通配符是反掩码
3. **调整 cost 或带宽** — 影响选路；默认按接口带宽计算
   - 验证：`display ospf interface`
4. **验证** — 邻居 FULL、路由表出现远端网段
   - 验证：`display ip routing-table protocol ospf`

**易错点**

- 反掩符写错（写成子网掩码）会宣告错网段
- 邻居卡在 2-Way 通常是 DR 选举正常但网络类型不匹配

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | 互联 R2 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 | 互联 R3 |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 |  |
| R1 | GigabitEthernet0/0/1 | 10.0.13.1/24 | 互联 R3 |
| R3 | GigabitEthernet0/0/1 | 10.0.13.3/24 |  |
| R1 | LoopBack0 | 1.1.1.1/32 | router-id 与业务网段 |
| R2 | LoopBack0 | 2.2.2.2/32 |  |
| R3 | LoopBack0 | 3.3.3.3/32 |  |

生成：`ensp preset ospf-single --topo ospf-single.topo`

### dhcp — DHCP 服务（含中继）

- **英文名**：DHCP server and relay
- **来源**：eNSP HCNA Lab 5-2
- **设备**：1 台路由器/交换机作 DHCP + PC
- **目标**：自动分配地址；跨网段时用中继

**配置顺序**

1. **启用 DHCP** — 全局 dhcp enable 必须先做
   - 验证：`display dhcp server statistics`
2. **建地址池** — network、gateway-list、dns-list
   - 验证：`display ip pool`
3. **接口绑定** — 本网段用 dhcp select global/interface；跨网段加 dhcp relay
   - 验证：`display dhcp relay`

**易错点**

- 地址池建了但接口没绑 dhcp select，客户端拿不到地址（静默失败）
- 中继场景下 DHCP 服务器必须有回程路由到客户端网段

**拓扑蓝图**

- 设备：R1 (AR2220)、SW1 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 192.168.10.254/24 | 地址池网关 |
| R1 | LoopBack0 | 1.1.1.1/32 | router-id |

生成：`ensp preset dhcp --topo dhcp.topo`

### acl-filter — ACL 访问控制

- **英文名**：ACL filtering
- **来源**：eNSP HCNA Lab 3-1
- **设备**：2 台路由器
- **目标**：按源/目的/协议精确放行或拒绝

**配置顺序**

1. **选 ACL 类型** — 基本(2000-2999)只看源；高级(3000-3999)看五元组
2. **写规则并注意顺序** — 精确匹配在前、宽泛规则在后；默认末尾隐含拒绝
   - 验证：`display acl 3000`
3. **应用到接口方向** — inbound 是进入接口的流量；方向选反等于不生效
   - 验证：`display traffic-filter applied-record`

**易错点**

- 反掩码（通配符）写错会连带放行/拒绝相邻网段
- 方向选反是静默失效，接口计数不增长

**拓扑蓝图**

- 设备：R1 (AR2220)、SW1 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 192.168.10.254/24 | PC1 网关，ACL 挂这里 |
| R1 | GigabitEthernet0/0/0 | 192.168.20.253/24 | 同接口从地址 |

生成：`ensp preset acl-filter --topo acl-filter.topo`

### aaa-local — 本地 AAA 与设备登录

- **英文名**：Local AAA and device login
- **来源**：eNSP HCNA Lab 3-3
- **设备**：任意设备
- **目标**：统一账号、SSH 登录、VTY 限源

**配置顺序**

1. **建本地用户** — 设置 privilege 与 service-type
   - 验证：`display aaa local-user`
2. **VTY 用 aaa 认证** — authentication-mode aaa + protocol inbound ssh
   - 验证：`display user-interface 0`
3. **VTY 限源 ACL** — 只允许管理网段登录
   - 验证：`display current-configuration | include acl`

**易错点**

- protocol inbound 未改 ssh 时 telnet 仍可登录
- ACL 把管理网段自己挡掉会锁死远程登录

**拓扑蓝图**

- 设备：R1 (AR2220)、ADMIN (PC)
- 链路：1 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/1 | 192.168.1.254/24 | 管理网段 |

生成：`ensp preset aaa-local --topo aaa-local.topo`

### vrrp-basics — VRRP 网关冗余

- **英文名**：VRRP gateway redundancy
- **来源**：eNSP 常规实验
- **设备**：2 台三层交换机/路由器 + PC
- **目标**：两台设备共用一个虚拟网关，主设备故障时秒级切换

**配置顺序**

1. **两台设备同网段同 Vlanif** — 虚拟网关地址在同一个二层域内才有效
   - 验证：`display ip interface brief`
2. **建 VRRP 组** — 两端 vrid 必须一致；虚拟 IP 不能与任何真实接口地址冲突
   - 验证：`display vrrp`
3. **定主备** — 优先级大者为主（默认 100，最大 254）；地址拥有者优先级 255
4. **加认证** — 两端 authentication-mode 与密钥必须一致，否则报文被丢弃、双主
   - 验证：`display vrrp verbose`
5. **加 track 上行** — track interface 上行口，主设备上行断则主动降优先级让备接管
   - 验证：`display vrrp`

**易错点**

- 两端 vrid 或认证不一致会各自成为 Master，形成双主且无任何报错
- 只配优先级不配 track，主设备上行断了仍占着虚拟 MAC，业务全断
- track 的 reduced 值太大会让备设备比主还低，切换后无法回切
- 虚拟 IP 配成某台设备的真实接口地址会报错

**拓扑蓝图**

- 设备：SW1 (S5700)、SW2 (S5700)、ACC (S5700)、PC1 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| SW1 | Vlanif10 | 192.168.10.252/24 | VRRP 主，虚拟地址 .254 |
| SW2 | Vlanif10 | 192.168.10.253/24 | VRRP 备 |
| SW1 | Vlanif100 | 10.0.100.1/24 | 上行互联 |
| SW2 | Vlanif100 | 10.0.100.2/24 | 上行互联 |

生成：`ensp preset vrrp-basics --topo vrrp-basics.topo`

### network-management — 网络管理（SNMP / NTP / Syslog）

- **英文名**：Network management with SNMP, NTP and syslog
- **来源**：eNSP 常规实验
- **设备**：2~3 台设备 + 1 台管理服务器
- **目标**：设备可被网管平台监控、时间同步、日志集中收集

**配置顺序**

1. **SNMP** — snmp-agent 开团本，配 v2c community 或 v3 用户，ACL 限源
   - 验证：`display snmp-agent sys-info`
2. **NTP** — 客户端 ntp-service unicast-server 指向时钟源；层级用 stratum 区分
   - 验证：`display ntp status`
3. **Syslog** — info-center loghost 指定日志服务器，别把 info-center 整体关掉
   - 验证：`display info-center`
4. **验证** — 网管能取到接口流量；设备时间与服务器一致；服务器收到日志

**易错点**

- undo info-center enable 是关掉整个日志系统，连本地缓存都没了，与日志审计要求直接冲突
- SNMP community 用 public/private 且不限源，等于把设备交出去
- NTP 单向可达（服务器回包被 ACL 挡）时同步不上，display ntp status 显示 unsynchronized
- 日志服务器地址不可达时设备只在本地缓冲，缓冲满了就丢，没有任何提示

**拓扑蓝图**

- 设备：R1 (AR2220)、SW1 (S5700)、NMS (PC)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.1.30.254/24 | NMS 网段 |
| R1 | LoopBack0 | 1.1.1.1/32 | 设备管理地址 |
| SW1 | Vlanif30 | 10.1.30.2/24 | 设备管理地址 |

生成：`ensp preset network-management --topo network-management.topo`


## 进阶

### mstp-load-balance — MSTP 多实例负载分担

- **英文名**：MSTP multi-instance load sharing
- **来源**：eNSP HCNA Lab 3-2 延伸
- **设备**：2 核心 + 2 汇聚
- **目标**：不同 VLAN 走不同根桥，两条上行都承载流量

**配置顺序**

1. **统一域参数** — 域名、修订级别、实例-VLAN 映射必须全网一致
   - 验证：`display stp region-configuration`
2. **分实例设优先级** — 实例 1 核心 A 为根、实例 2 核心 B 为根
   - 验证：`display stp instance 1 brief`
3. **实例 0 显式指定** — 未映射 VLAN 落在 CIST，同样要指定根桥
   - 验证：`display stp instance 0 brief`

**易错点**

- 域参数不一致会退化成单实例，负载分担失效且无明显报错
- 只配实例 1/2 而忽略实例 0，管理 VLAN 可能二层割裂

**拓扑蓝图**

- 设备：CORE1 (S5700)、CORE2 (S5700)、ACC1 (S5700)、ACC2 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：6 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| CORE1 | Vlanif10 | 192.168.10.252/24 | VLAN10 网关（实例1 主） |
| CORE1 | Vlanif20 | 192.168.20.253/24 | VLAN20 网关（实例2 备） |
| CORE2 | Vlanif10 | 192.168.10.253/24 | VLAN10 网关（实例1 备） |
| CORE2 | Vlanif20 | 192.168.20.252/24 | VLAN20 网关（实例2 主） |

生成：`ensp preset mstp-load-balance --topo mstp-load-balance.topo`

### ospf-multi-area — OSPF 多区域与 ABR

- **英文名**：OSPF multi-area and ABR
- **来源**：eNSP 2-2 Multi-Area OSPF
- **设备**：4 台路由器
- **目标**：区域划分、ABR 路由汇总、区域间路由传播

**配置顺序**

1. **划分区域** — 骨干 area 0 必须连续；非骨干挂在 ABR 上
   - 验证：`display ospf brief`
2. **ABR 汇总** — 在 ABR 上对区域间路由做 abr-summary
   - 验证：`display ospf abr-asbr`
3. **验证区域间路由** — 其他区域应看到汇总路由而非明细
   - 验证：`display ip routing-table protocol ospf`

**易错点**

- 非骨干区域未连接 area 0 会导致路由不计算（需 virtual-link）
- 汇总掩码写错会连带屏蔽不该屏蔽的网段

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、R4 (AR2220)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | LoopBack0 | 1.1.1.1/32 | 在 area 0 |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | area 0 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | area 0 |
| R1 | GigabitEthernet0/0/1 | 10.0.13.1/24 | area 1（R1 为 ABR） |
| R3 | GigabitEthernet0/0/0 | 10.0.13.3/24 | area 1 |
| R2 | GigabitEthernet0/0/1 | 10.0.24.2/24 | area 2（R2 为 ABR） |
| R4 | GigabitEthernet0/0/0 | 10.0.24.4/24 | area 2 |

生成：`ensp preset ospf-multi-area --topo ospf-multi-area.topo`

### ospf-stub-nssa — OSPF 特殊区域（Stub / NSSA）

- **英文名**：OSPF stub and NSSA
- **来源**：eNSP 2-4 OSPF Stub Area and NSSA
- **设备**：3~4 台路由器
- **目标**：用特殊区域减少 LSA 泛洪；理解默认路由自动下发条件

**配置顺序**

1. **边缘区域设 stub** — 区域内所有路由器都要配 stub
   - 验证：`display ospf brief`
2. **需要引入外部路由时改 NSSA** — NSSA 允许 ASBR 存在，通过 Type-7 转换
3. **验证 LSA 类型** — stub 区域无 Type-5；NSSA 有 Type-7
   - 验证：`display ospf lsdb`

**易错点**

- 区域类型不一致会导致邻居无法建立
- stub 区域不能有 ASBR；需要引入时只能用 NSSA

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、R4 (AR2220)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | area 0 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | area 0 |
| R1 | GigabitEthernet0/0/1 | 10.0.13.1/24 | area 1 → stub |
| R3 | GigabitEthernet0/0/0 | 10.0.13.3/24 | area 1 |
| R1 | GigabitEthernet0/0/2 | 10.0.14.1/24 | area 2 → nssa |
| R4 | GigabitEthernet0/0/0 | 10.0.14.4/24 | area 2 |

生成：`ensp preset ospf-stub-nssa --topo ospf-stub-nssa.topo`

### ospf-lsa-types — OSPF LSA 类型与区域过滤

- **英文名**：OSPF LSA types and area filtering
- **来源**：eNSP 2-3 OSPF Adjacency Relationships and Various Types of LSAs
- **设备**：4 台路由器（骨干 + 两个非骨干区域）
- **目标**：观察 Type-1/2/3/4/5/7 的产生位置与泛洪范围，并在 ABR 上过滤区域间路由

**配置顺序**

1. **建立多区域拓扑** — 两台 ABR 各挂一个非骨干区域，其中一侧引入外部路由
   - 验证：`display ospf brief`
2. **逐个区域看 LSDB** — 区域内看 Type-1/2；ABR 上额外有 Type-3；ASBR 所在区域有 Type-5
   - 验证：`display ospf lsdb`
3. **观察 ASBR 与外部路由** — Type-4 描述 ASBR 位置，由 ABR 产生；Type-5 携带外部网段
   - 验证：`display ospf lsdb ase`
4. **NSSA 场景看 Type-7** — NSSA 内引入的外部路由先以 Type-7 存在，由 ABR 转换成 Type-5
   - 验证：`display ospf lsdb nssa`
5. **在 ABR 上过滤 Type-3** — filter import/export 配合 ACL 或 ip-prefix，只影响区域间路由
   - 验证：`display ospf lsdb summary`

**易错点**

- Type-3 只有 ABR 会产生，普通区域内的路由器看不到也不会转发
- Type-5 不进 stub 区域，这是 stub 的本意；想带外部路由只能用 NSSA
- filter 只过滤区域间（Type-3），对区域内和外部路由无效
- abr-summary not-advertise 与 filter deny 效果相似但粒度不同，混用会互相抵消

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、R4 (AR2220)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | area 1 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 | area 0 |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 |  |
| R3 | GigabitEthernet0/0/1 | 10.0.34.3/24 | area 2 / stub |
| R4 | GigabitEthernet0/0/0 | 10.0.34.4/24 |  |
| R1 | LoopBack0 | 1.1.1.1/32 | Type-1 观察点 |
| R2 | LoopBack0 | 2.2.2.2/32 | ABR |
| R3 | LoopBack0 | 3.3.3.3/32 | ABR |
| R4 | LoopBack0 | 4.4.4.4/32 | ASBR 外部路由 |

生成：`ensp preset ospf-lsa-types --topo ospf-lsa-types.topo`

### ospf-virtual-link — OSPF 虚连接

- **英文名**：OSPF virtual link
- **来源**：eNSP 2-5 OSPF VCs and Inter-Area Route Filtering
- **设备**：4 台路由器（一个区域被割裂）
- **目标**：让未直连骨干区域的区域通过 transit 区域接入 area 0

**配置顺序**

1. **确认割裂点** — 非骨干区域两侧都没有物理接口在 area 0 内
   - 验证：`display ospf brief`
2. **两端 ABR 配 vlink-peer** — 指向对端 router-id，不是接口地址；两端都要配
   - 验证：`display ospf vlink`
3. **确认 transit 区域是普通区域** — 虚连接只能穿过普通区域，不能穿 stub 或 NSSA
4. **验证区域间路由恢复** — 割裂侧应重新学到 Type-3 路由
   - 验证：`display ip routing-table protocol ospf`

**易错点**

- vlink-peer 填成接口 IP 而不是 router-id，虚连接起不来
- 只配一端：状态会停在 INIT 或 DOWN
- 用 stub 区域当 transit 会直接报错，特殊区域不能承载虚连接
- 虚连接是过渡手段，物理上补齐 area 0 直连才是正规做法

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | area 0 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | area 0 |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 | area 1（transit） |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 | area 1 |
| R3 | LoopBack0 | 3.3.3.3/32 | 虚拟链路的两端 router-id |

生成：`ensp preset ospf-virtual-link --topo ospf-virtual-link.topo`

### ospf-troubleshooting — OSPF 邻居排障

- **英文名**：OSPF neighbour troubleshooting
- **来源**：eNSP 2-6 OSPF Troubleshooting / 本项目实测
- **设备**：2~3 台路由器
- **目标**：按状态机逐层定位邻居建立失败的原因

**配置顺序**

1. **先读状态** — Down 无 Hello；Init 单向收到；2-Way 正常但不是 DR/BDR；ExStart 卡在 DD 交换
   - 验证：`display ospf peer`
2. **查 Hello 参数** — 区域号、hello/dead 定时器、认证、网络类型、掩码（broadcast 下要求同掩码）必须一致
   - 验证：`display ospf interface`
3. **查报文层错误** — MTU 不一致会让 DD 交换卡在 ExStart；ACL 挡 224.0.0.5/224.0.0.6 会让邻居根本起不来
   - 验证：`display ospf error`
4. **确认接口 MTU** — 两侧 MTU 必须相等；也可用 ospf mtu-enable 让 DD 携带 MTU 并显式报错
   - 验证：`display interface GigabitEthernet0/0/0 | include MTU`
5. **确认直连可达** — ping 对端接口地址通不通，不通则先解决二层或地址问题

**易错点**

- ExStart 卡住最常见原因是 MTU 不一致，但 display ospf peer 不会直接告诉你是 MTU
- 2-Way 在点到点场景可能正常，在 broadcast 场景说明双方都是 DR-Other，需要看 DR 是否已选出
- 改完参数邻居不会立刻重建，undo 掉进程或 shutdown 接口再开更快
- 掩码不一致在 broadcast 网络会直接导致邻居关系无法建立，且报错信息很含糊

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | 故意配错 area 做排障 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 |  |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 |  |
| R2 | LoopBack0 | 2.2.2.2/32 | router-id 冲突观察点 |
| R3 | LoopBack0 | 2.2.2.2/32 |  |

生成：`ensp preset ospf-troubleshooting --topo ospf-troubleshooting.topo`

### nat — NAT（源 NAT / NAT Server）

- **英文名**：NAT source and server
- **来源**：eNSP HCNA Lab 3-2
- **设备**：内网路由器 + 出口路由器 + 外部
- **目标**：内网访问外网、外网访问内网服务器

**配置顺序**

1. **写 ACL 匹配内网源** — permit 需要转换的源网段
   - 验证：`display acl`
2. **出口配 nat outbound** — 绑定 ACL；easy-ip 用接口地址
   - 验证：`display nat session all`
3. **发布服务器用 nat server** — 公网地址端口 -> 内网地址端口
4. **验证回程** — NAT 后需保证回程路由指向出口

**易错点**

- ACL 未命中则不做转换，且无报错
- NAT Server 后仍需要放行安全策略/ACL

**拓扑蓝图**

- 设备：R1 (AR2220)、ISP (AR2220)、PC1 (PC)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/1 | 192.168.1.254/24 | 内网网关 |
| R1 | GigabitEthernet0/0/0 | 200.1.1.1/30 | 公网侧（NAT outside） |
| ISP | GigabitEthernet0/0/0 | 200.1.1.2/30 | 模拟运营商 |
| ISP | LoopBack0 | 8.8.8.8/32 | 模拟 Internet 目的地址 |

生成：`ensp preset nat --topo nat.topo`

### ppp-hdlc — HDLC 与 PPP（含 PPPoE）

- **英文名**：HDLC and PPP
- **来源**：eNSP HCNA Lab 2-1 / 2-3
- **设备**：2 台路由器（串口）
- **目标**：串口封装、PPP 认证、PPPoE 拨号

**配置顺序**

1. **设封装类型** — HDLC 为默认；PPP 支持认证与多链路
   - 验证：`display interface Serial`
2. **配置认证** — 一端 authenticator，另一端 pap/chap 用户名密码
   - 验证：`display ppp interface`
3. **PPPoE** — 服务端建 VT 与地址池，客户端 dialer 拨号
   - 验证：`display pppoe-client session summary`

**易错点**

- PPP 认证两端 pap/chap 不一致会反复协商失败
- 串口需先确认物理 up 且时钟配置正确

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/30 | link-protocol ppp + CHAP |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/30 |  |
| R1 | GigabitEthernet0/0/1 | 10.0.13.1/30 | link-protocol hdlc 对照 |
| R2 | GigabitEthernet0/0/1 | 10.0.13.2/30 |  |

生成：`ensp preset ppp-hdlc --topo ppp-hdlc.topo`

### ipv6 — IPv6 基础与路由

- **英文名**：IPv6 basics and routing
- **来源**：eNSP HCNA Lab 5-1
- **设备**：2~3 台路由器
- **目标**：IPv6 地址、邻居发现、静态/OSPFv3 路由

**配置顺序**

1. **全局启用 IPv6** — 接口下也要 ipv6 enable
   - 验证：`display ipv6 interface brief`
2. **配地址** — 可用链路本地 + 全球单播，或 address auto link-local
3. **路由** — 静态 ipv6 route 或 ospfv3
   - 验证：`display ipv6 routing-table`

**易错点**

- 只配 global 未在接口 enable ipv6，邻居发现不工作
- IPv6 无 ARP，ND 未通则 ping 不通

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)
- 链路：1 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 2001:db8:12::1/64 | IPv6 互联 |
| R2 | GigabitEthernet0/0/0 | 2001:db8:12::2/64 |  |
| R1 | LoopBack0 | 2001:db8:1::1/128 |  |
| R2 | LoopBack0 | 2001:db8:2::2/128 |  |

生成：`ensp preset ipv6 --topo ipv6.topo`

### dhcp-snooping — DHCP Snooping 与 IPSG

- **英文名**：DHCP snooping and IPSG
- **来源**：eNSP 常规实验
- **设备**：1 台三层交换机 + 1 台接入交换机 + PC
- **目标**：阻断私接 DHCP 服务器，绑定合法地址防止 IP 冒用

**配置顺序**

1. **全局开 DHCP Snooping** — dhcp snooping enable，再按 VLAN 开 dhcp snooping enable
   - 验证：`display dhcp snooping`
2. **上行口设 trusted** — 接合法 DHCP 服务器的口必须 dhcp snooping trusted，否则所有 DHCP 报文被丢
3. **接入口保持 untrusted** — 用户口默认 untrusted，收到 DHCP Offer 直接丢弃
   - 验证：`display dhcp snooping user-info`
4. **开 IPSG** — ip source check user-bind enable，基于 snooping 表项校验源 IP+MAC
5. **验证** — 私接 DHCP 服务器后 PC 拿不到错误地址；手工改 IP 后无法上网

**易错点**

- 上行口忘记 trusted 是黑白名单反了，表现为全网 DHCP 都拿不到地址
- trusted 配在不存在的接口上不会报错，等于没配
- IPSG 依赖 snooping 表项，静态 IP 用户需要手工绑定静态表项

**拓扑蓝图**

- 设备：SW1 (S5700)、R1 (AR2220)、PC1 (PC)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 192.168.10.254/24 | DHCP 服务器 |
| SW1 | Vlanif10 | 192.168.10.253/24 | 管理地址 |

生成：`ensp preset dhcp-snooping --topo dhcp-snooping.topo`

### arp-security — ARP 安全（防欺骗与防攻击）

- **英文名**：ARP security
- **来源**：eNSP 常规实验
- **设备**：1 台交换机 + 3 PC
- **目标**：防御 ARP 欺骗、ARP 泛洪，保证网关 MAC 不被冒充

**配置顺序**

1. **静态绑定网关** — 用户侧手工 arp static 或交换机侧 arp static，锁定网关 MAC
   - 验证：`display arp`
2. **开 ARP 检测** — arp anti-attack check user-bind enable，丢弃 MAC/IP 不匹配的 ARP
   - 验证：`display arp anti-attack`
3. **限速防泛洪** — arp anti-attack rate-limit 限制单位时间 ARP 报文数
4. **DAI 类方案** — 基于 DHCP Snooping 表项的动态 ARP 检测，比纯静态更适合终端多的场景
5. **验证** — 在攻击机上伪造网关 MAC 发 ARP，受害机 ARP 表不应被改写

**易错点**

- 只做静态绑定而不开检测，攻击者仍可伪造其他主机的 ARP
- ARP 检测依赖 DHCP Snooping 表项，纯静态 IP 环境要先造表
- 限速值设太小会把正常 ARP 也丢掉，表现为间歇性断网

**拓扑蓝图**

- 设备：SW1 (S5700)、PC1 (PC)、PC2 (PC)、PC3 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| SW1 | Vlanif10 | 192.168.10.254/24 | 网关兼 DHCP Snooping 设备 |

生成：`ensp preset arp-security --topo arp-security.topo`

### qos-basics — QoS 分类标记与队列

- **英文名**：QoS classification, marking and queues
- **来源**：eNSP 常规实验
- **设备**：2 台交换机 + PC + 打流工具
- **目标**：给语音/视频打高优先级，拥塞时优先转发、限制普通流量带宽

**配置顺序**

1. **分类** — traffic classifier 匹配 ACL 或 VLAN，指定 operator or/and
   - 验证：`display traffic classifier`
2. **标记** — traffic behavior 里 remark dscp 或 remark 8021p；标记要尽量靠近源端
3. **队列调度** — 接口下 qos schedule 或 diffserv domain，给高优先级队列加权
4. **限速与整形** — car 做入向限速，traffic shaping 做出向整形
   - 验证：`display qos car`
5. **绑定并验证** — traffic policy 绑到接口；打流观察高优先级丢包率
   - 验证：`display traffic policy statistics`

**易错点**

- 只标记不调度：标记完没人看，拥塞时仍是先到先服务
- 队列数超过接口支持数量会配不上，需先查接口默认队列模板
- 入向限速与出向整形混淆，用错方向限不住目标流量
- DSCP 与 802.1p 映射关系不一致会导致跨设备优先级丢失

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、PC1 (PC)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/1 | 192.168.1.254/24 | 入方向做流分类 |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | 出方向做限速 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |

生成：`ensp preset qos-basics --topo qos-basics.topo`

### wlan-basic — WLAN（AC + FIT AP）

- **英文名**：WLAN with AC and FIT AP
- **来源**：eNSP WLAN 实验
- **设备**：AC6005 + AP + 交换机
- **目标**：AP 上线、SSID 下发、终端接入

**配置顺序**

1. **AP 管理网段与 DHCP** — AP 需拿到地址并发现 AC（option 43 或同网段广播）
   - 验证：`display ap all`
2. **建安全/SSID/VAP 模板** — security-profile -> ssid-profile -> vap-profile
3. **绑定到 AP 组** — vap-profile 绑定 wlan 与 radio
   - 验证：`display vap ssid`

**易错点**

- AP 未上线通常是 DHCP option 43 或 CAPWAP 源地址未指定
- AC 与 AP 之间放行 CAPWAP（UDP 5246/5247）

**拓扑蓝图**

- 设备：AC (AC6005)、AP1 (AP6050)、SW1 (S5700)、PC1 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| AC | Vlanif100 | 192.168.100.1/24 | CAPWAP 源与管理 |
| AC | Vlanif50 | 192.168.50.254/24 | 业务网关 |
| SW1 | Vlanif100 | 192.168.100.254/24 | AP 管理网段 |

生成：`ensp preset wlan-basic --topo wlan-basic.topo`

### ospfv3-ipv6 — OSPFv3 与 IPv6 双栈

- **英文名**：OSPFv3 and IPv6 dual stack
- **来源**：eNSP HCNA Lab 5-1 延伸
- **设备**：3~4 台路由器
- **目标**：在 IPv6 网络上跑 OSPFv3，与 IPv4 并存互不干扰

**配置顺序**

1. **全局与接口双开 IPv6** — ipv6 全局开启，接口 ipv6 enable 并配地址
   - 验证：`display ipv6 interface brief`
2. **建 OSPFv3 进程** — ospfv3 1 需指定 router-id（用 IPv4 地址形式），再在接口 ospfv3 1 area 0
   - 验证：`display ospfv3 peer`
3. **观察链路本地地址** — OSPFv3 邻居用 fe80:: 建立，接口必须有链路本地地址
   - 验证：`display ospfv3 interface`
4. **验证路由** — IPv6 路由表出现对端网段，双栈下 IPv4 路由不受影响
   - 验证：`display ipv6 routing-table`

**易错点**

- 只开全局 ipv6 未在接口 ipv6 enable，接口没有链路本地地址，OSPFv3 邻居起不来
- OSPFv3 的 router-id 仍是 32 位点分十进制，不是 IPv6 地址
- OSPFv3 用链路本地地址泛洪，跨网段邻居需要额外的全局地址配置
- IPv6 没有 ARP，ND 未通时 ping 不通但接口是 up 的

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 2001:db8:12::1/64 | OSPFv3 area 0 |
| R2 | GigabitEthernet0/0/0 | 2001:db8:12::2/64 |  |
| R2 | GigabitEthernet0/0/1 | 2001:db8:23::2/64 |  |
| R3 | GigabitEthernet0/0/0 | 2001:db8:23::3/64 |  |
| R3 | LoopBack0 | 2001:db8:3::3/128 | router-id 用 IPv4 地址 |

生成：`ensp preset ospfv3-ipv6 --topo ospfv3-ipv6.topo`

### isis-multi-level — IS-IS 多级别与默认路由注入

- **英文名**：IS-IS levels and default-route injection
- **来源**：本项目实测验证（见 docs/SCENARIOS.md）
- **设备**：4 台路由器
- **目标**：L1/L2 分层，边界路由器隔离区域，L1 通过注入学默认路由

**配置顺序**

1. **规划 NET 与级别** — 同一区域用相同区域 ID；边界路由器 level-1-2
   - 验证：`display isis brief`
2. **配置 NET 并启用** — isis 进程下 network-entity，再在接口 isis enable
   - 验证：`display isis interface`
3. **注入默认路由** — L1 边缘路由器 default-route-advertise always level-1
   - 验证：`display ip routing-table`
4. **验证级别隔离** — L2 侧不应看到 L1 区域内部的默认路由注入
   - 验证：`display isis peer`

**易错点**

- NET 的 system-id 必须唯一，重复会导致邻居震荡
- 接口未 isis enable 时进程起来了但无邻居，且不报错
- 默认路由注入不带 level-1 限定会污染 L2

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、R4 (AR2220)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | level-1 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | level-1-2 |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 | level-1 |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 | level-1 |
| R2 | GigabitEthernet0/0/2 | 10.0.24.2/24 | level-2 |
| R4 | GigabitEthernet0/0/0 | 10.0.24.4/24 | level-2 |
| R1 | LoopBack0 | 1.1.1.1/32 |  |
| R3 | LoopBack0 | 3.3.3.3/32 |  |
| R4 | LoopBack0 | 4.4.4.4/32 |  |

生成：`ensp preset isis-multi-level --topo isis-multi-level.topo`


## 高级

### bgp-ebgp-ibgp — BGP EBGP / IBGP

- **英文名**：BGP peering
- **来源**：eNSP 3-1/3-2/3-3
- **设备**：3~4 台路由器
- **目标**：建立 EBGP 与 IBGP 邻居，理解 next-hop 与同步

**配置顺序**

1. **建 BGP 进程与 AS 号** — AS 号决定 EBGP/IBGP 关系
   - 验证：`display bgp peer`
2. **配置 peer** — IBGP 常用 loopback + update-source；EBGP 用直连口
   - 验证：`display bgp peer verbose`
3. **宣告网段** — network 只能宣告路由表中存在的精确网段
4. **处理下一跳** — IBGP 需 next-hop-local，否则路由不可达
   - 验证：`display bgp routing-table`

**易错点**

- IBGP 邻居未 update-source 到 loopback 时，源地址不匹配会卡在 Connect
- network 宣告的网段路由表里不存在则不会发布，且无提示

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | LoopBack0 | 1.1.1.1/32 | AS 100 |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | AS 100 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | AS 100 |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 | AS 100 → EBGP |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 | AS 200 |
| R3 | LoopBack0 | 3.3.3.3/32 | AS 200 业务网段 |

生成：`ensp preset bgp-ebgp-ibgp --topo bgp-ebgp-ibgp.topo`

### bgp-attributes — BGP 选路属性

- **英文名**：BGP attributes and path selection
- **来源**：eNSP 3-3 / 3-4 BGP Attributes and Path Selection
- **设备**：4 台路由器（两个 AS，含一台双出口路由器）
- **目标**：用 local-preference、AS_PATH、MED 分别影响入向和出向选路

**配置顺序**

1. **造出多条等价路径** — 同一前缀从两个方向学到，先确认 BGP 表里有多条 candidate
   - 验证：`display bgp routing-table`
2. **影响入向：local-preference** — 值大优先，只在 IBGP 内传递，用于让本 AS 偏好某个入口
3. **影响出向：AS_PATH prepend** — 在不想被选中的方向重复本 AS 号，让对端觉得这条更长
4. **影响出向：MED** — 值小优先，可跨 EBGP 传递，但对端不一定采纳
5. **看清比较顺序** — weight > local-preference > 本地始发 > AS_PATH 长度 > origin > MED > EBGP 优于 IBGP > IGP cost > router-id
   - 验证：`display bgp routing-table 10.0.0.0`

**易错点**

- weight 是本机私有属性，不传递，配错方向时完全没效果
- local-preference 默认 100，只在 IBGP 内传递，跨 EBGP 会被重置
- MED 只在同一对 AS 之间比较，且对端可用 always-compare-med 改变行为
- 只看 BGP 表不看出方向，容易误判成属性没生效

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、R4 (AR2220)
- 链路：4 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | AS 100 双出口 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | AS 200 |
| R1 | GigabitEthernet0/0/1 | 10.0.13.1/24 |  |
| R3 | GigabitEthernet0/0/0 | 10.0.13.3/24 | AS 300 |
| R2 | GigabitEthernet0/0/1 | 10.0.24.2/24 |  |
| R4 | GigabitEthernet0/0/0 | 10.0.24.4/24 | AS 400 选路观察点 |
| R3 | GigabitEthernet0/0/1 | 10.0.34.3/24 |  |
| R4 | GigabitEthernet0/0/1 | 10.0.34.4/24 |  |

生成：`ensp preset bgp-attributes --topo bgp-attributes.topo`

### bgp-aggregation — BGP 路由聚合与团体属性

- **英文名**：BGP aggregation and communities
- **来源**：eNSP 3-2 BGP Route Aggregation
- **设备**：3~4 台路由器
- **目标**：把明细路由聚合成一条，并控制聚合后是否保留明细与 AS_PATH 信息

**配置顺序**

1. **先有可聚合的明细** — 至少两条同前缀长度的明细路由在 BGP 表中
   - 验证：`display bgp routing-table`
2. **配 aggregate** — 指定聚合网段与掩码，默认同时发布聚合与明细
   - 验证：`display bgp routing-table`
3. **抑制明细** — detail-suppressed 只发聚合；suppress-policy 按策略选择性抑制
4. **保留 AS_PATH 信息** — as-set 让聚合路由携带明细的 AS 集合，避免被对端当成更优路径
5. **团体属性** — apply community 打标记，对端用 community-filter 做策略
   - 验证：`display bgp routing-table community`

**易错点**

- 聚合路由默认不继承明细的 AS_PATH，可能造成环路或选路异常，需要 as-set
- 只配聚合不抑制明细，路由条目数并不会减少
- 聚合网段必须覆盖所有明细，否则会产生黑洞
- 团体属性默认不传递，需显式 peer advertise-community

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | AS 100，发布明细 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | AS 200，做聚合 |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 |  |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 | AS 300，验证 AS_PATH |
| R1 | LoopBack0 | 10.10.1.1/24 | 聚合前明细 1 |
| R1 | LoopBack1 | 10.10.2.1/24 | 聚合前明细 2 |
| R1 | LoopBack2 | 10.10.3.1/24 | 聚合前明细 3 |

生成：`ensp preset bgp-aggregation --topo bgp-aggregation.topo`

### bgp-troubleshooting — BGP 邻居排障

- **英文名**：BGP neighbour troubleshooting
- **来源**：eNSP 3-6 BGP Troubleshooting
- **设备**：3 台路由器
- **目标**：按邻居状态机定位 BGP 建立失败的原因

**配置顺序**

1. **读状态** — Idle 未发起；Connect/Active 在尝试 TCP；OpenSent/OpenConfirm 在协商；Established 才算成功
   - 验证：`display bgp peer`
2. **查 TCP 179** — 先确认到对端 179 端口可连，路由不可达时永远停在 Connect
   - 验证：`display tcp status`
3. **查对端配置** — AS 号、peer 地址、router-id 唯一性；IBGP 是否 update-source 到 loopback
   - 验证：`display bgp peer verbose`
4. **查策略拦截** — ACL 或防火墙是否放行 179；EBGP 是否配了 ebgp-max-hop（非直连时）
5. **看具体错误码** — verbose 输出里的 last error 与 notification 码直接指向原因

**易错点**

- 两个邻居用相同 router-id 会互相踢下线，表现为 Established 反复抖动
- IBGP 用 loopback 建邻居但没配 update-source，源地址不匹配永远连不上
- EBGP 非直连建邻必须 ebgp-max-hop，否则报文 TTL 为 1 被丢弃
- hold timer 不一致会协商成较小值，网络抖动时容易误判断开

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | AS 100 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 | AS 200 |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 |  |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 | AS 300 |
| R1 | LoopBack0 | 1.1.1.1/32 | TCP 179 源地址 |
| R3 | LoopBack0 | 3.3.3.3/32 |  |

生成：`ensp preset bgp-troubleshooting --topo bgp-troubleshooting.topo`

### stack-istack — 交换机堆叠与 iStack

- **英文名**：Switch stacking and iStack
- **来源**：eNSP 常规实验
- **设备**：2~4 台同型号交换机 + 1 台上行设备
- **目标**：多台物理交换机合成一台逻辑设备，跨成员链路聚合、单一管理地址

**配置顺序**

1. **规划主备与成员编号** — 先定主交换机（priority 高）、再定成员 ID，编号必须唯一
   - 验证：`display stack`
2. **配堆叠端口** — 用专用堆叠卡口或业务口做 stack-port，两台设备互联成环更可靠
   - 验证：`display stack configuration`
3. **上电合并** — 先配好再同时重启，成员加入后堆叠 ID 生效
4. **跨成员聚合** — Eth-Trunk 成员口分布在不同成员上，单成员故障链路仍可用
   - 验证：`display eth-trunk`
5. **管理面验证** — 整机只有一个管理 IP，成员口统一编号（如 GigabitEthernet1/0/1 与 2/0/1）
   - 验证：`display interface brief`

**易错点**

- 两台设备都用默认优先级 100 时主备由 MAC 决定，换设备后主备关系会变
- 堆叠 ID 重复会导致成员无法加入，且报错信息很简短
- 堆叠线接成单链而非环，一条线断就分裂成两台独立设备（双主）
- 分裂后两台都认为自己为主，若没配双主检测会导致地址冲突

**拓扑蓝图**

- 设备：SW1 (S5700)、SW2 (S5700)、SW3 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：4 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| SW1 | Vlanif10 | 192.168.10.251/24 | 堆叠主，唯一管理地址 |
| SW2 | Vlanif10 | 192.168.10.252/24 | 堆叠备 |
| SW3 | Vlanif10 | 192.168.10.253/24 | 接入设备 |

生成：`ensp preset stack-istack --topo stack-istack.topo`

### route-policy-pbr — 路由策略与策略路由

- **英文名**：Route policy and policy-based routing
- **来源**：eNSP 常规实验
- **设备**：3 台路由器（双出口）
- **目标**：用 route-policy 过滤/修改路由，用 PBR 让特定流量走指定出口

**配置顺序**

1. **先写匹配条件** — ip-prefix 或 ACL 描述网段，community-filter 描述团体
   - 验证：`display ip ip-prefix`
2. **写 route-policy 节点** — if-match 匹配，apply 修改 cost/tag/preference；节点号小的先匹配
   - 验证：`display route-policy`
3. **挂到协议上** — import-route 时引用，或 BGP peer 的 route-policy import/export
4. **策略路由另行处理** — traffic classifier + behavior（redirect ip-nexthop）+ traffic policy，绑到接口 inbound
   - 验证：`display traffic policy`
5. **验证分流** — 用 tracert 看不同源/目的的流量是否走了不同下一跳

**易错点**

- route-policy 末尾隐含 deny，没被任何节点匹配上的路由会被丢弃
- 只写 if-match 不写 apply 也能命中，但行为是 permit 且不修改属性
- PBR 优先级高于路由表，配错会绕过正常转发路径且很难排查
- 策略路由只能匹配接口入方向，出方向需要换方案

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、PC1 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/2 | 192.168.1.254/24 | PC1 网关 |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | 出口 1 |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| R1 | GigabitEthernet0/0/1 | 10.0.13.1/24 | 出口 2 |
| R3 | GigabitEthernet0/0/0 | 10.0.13.3/24 |  |
| R2 | LoopBack0 | 2.2.2.2/32 | 同一目的网段的两个出口 |
| R3 | LoopBack0 | 2.2.2.2/32 | 与出口 1 相同的地址，用于观察选路 |

生成：`ensp preset route-policy-pbr --topo route-policy-pbr.topo`

### bgp-route-reflector — BGP 路由反射器与联盟

- **英文名**：BGP route reflector and confederation
- **来源**：eNSP 3-7 / 3-8
- **设备**：4~5 台路由器
- **目标**：解决 IBGP 全互联问题

**配置顺序**

1. **选 RR** — 在 RR 上把客户端指定为 reflector-client
   - 验证：`display bgp peer`
2. **验证反射** — 客户端之间无需直连即可学到路由
   - 验证：`display bgp routing-table`
3. **可选：联盟** — 大 AS 拆子 AS，跨子 AS 仍是 IBGP 语义

**易错点**

- RR 的 cluster-id 冲突会造成环路防护误判
- 客户端配置遗漏则路由不会反射

**拓扑蓝图**

- 设备：RR (AR2220)、R2 (AR2220)、R3 (AR2220)、EXT (AR2220)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| RR | LoopBack0 | 10.1.1.1/32 | AS 100 内 reflector |
| RR | GigabitEthernet0/0/0 | 10.1.12.1/24 | AS 100 |
| R2 | GigabitEthernet0/0/0 | 10.1.12.2/24 | AS 100 client |
| RR | GigabitEthernet0/0/1 | 10.1.13.1/24 | AS 100 |
| R3 | GigabitEthernet0/0/0 | 10.1.13.3/24 | AS 100 client |
| R2 | GigabitEthernet0/0/1 | 10.1.24.2/24 | AS 100 → EBGP |
| EXT | GigabitEthernet0/0/0 | 10.1.24.4/24 | AS 200 |

生成：`ensp preset bgp-route-reflector --topo bgp-route-reflector.topo`

### ipsec-vpn — IPsec VPN

- **英文名**：IPsec VPN
- **来源**：eNSP HCNA Lab 3-4
- **设备**：2 台出口路由器
- **目标**：两端私网通过公网安全互通

**配置顺序**

1. **定义感兴趣流** — ACL 匹配两端私网互访
2. **配置 IKE 提议与 keychain** — 两端参数必须完全一致
   - 验证：`display ike sa`
3. **配置 IPsec 提议与策略** — 封装模式、协议、算法两端一致
   - 验证：`display ipsec sa`
4. **应用到接口** — 在公网出接口引用策略
   - 验证：`display ipsec policy`

**易错点**

- 两端提议任一参数不一致则 IKE 阶段就失败
- ACL 匹配范围不对会导致部分流量不走隧道

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、PC1 (PC)、PC2 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/1 | 192.168.1.254/24 | 私网侧 |
| R1 | GigabitEthernet0/0/0 | 200.1.1.1/24 | 公网侧 |
| R2 | GigabitEthernet0/0/0 | 200.1.1.2/24 | 公网侧 |
| R2 | GigabitEthernet0/0/1 | 192.168.2.254/24 | 私网侧 |

生成：`ensp preset ipsec-vpn --topo ipsec-vpn.topo`

### multicast-pim-sm — 组播 PIM-SM 与 IGMP

- **英文名**：Multicast with PIM-SM and IGMP
- **来源**：eNSP 5-2 PIM-SM and Dynamic RP / multicast
- **设备**：4~5 台路由器 + 组播服务器 + 接收者
- **目标**：用 PIM-SM 建立共享树与最短路径树，接收者按需加入组播组

**配置顺序**

1. **全局开组播** — multicast routing-enable 必须在所有组播路由器上开
   - 验证：`display pim`
2. **配 IGMP** — 面向接收者的接口开 igmp enable，指定版本（默认 v2）
   - 验证：`display igmp group`
3. **配 PIM-SM** — 所有三层接口开 pim sm，形成 RPF 邻居
   - 验证：`display pim neighbor`
4. **配 RP** — 静态 RP pim static-rp，或动态 BSR/C-RP；所有路由器 RP 信息必须一致
   - 验证：`display pim rp-info`
5. **验证树形** — 初始为共享树（*，G），源出现后切到 SPT（S，G）
   - 验证：`display pim routing-table`

**易错点**

- 未开 multicast routing-enable 时接口 pim 命令根本挂不上
- RPF 检查看的是单播路由，单播回程不对会导致组播流量被丢弃
- RP 地址不一致会导致不同路由器算出不同共享树，组播时通时不通
- 接收者侧接口没开 IGMP，PIM 邻居正常但流量下不来
- eNSP 组播需要设备支持组播转发，部分低端型号不可用

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、SRC (PC)、RCV (PC)
- 链路：4 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | LoopBack0 | 1.1.1.1/32 | 候选 RP（静态 RP 时指向它） |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 |  |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| R1 | GigabitEthernet0/0/1 | 10.0.13.1/24 |  |
| R3 | GigabitEthernet0/0/0 | 10.0.13.3/24 |  |
| R2 | GigabitEthernet0/0/1 | 192.168.2.254/24 | 组播源网段 |
| R3 | GigabitEthernet0/0/1 | 192.168.3.254/24 | 接收者网段 |

生成：`ensp preset multicast-pim-sm --topo multicast-pim-sm.topo`

### firewall-zones — 防火墙安全域与策略

- **英文名**：Firewall zones and security policies
- **来源**：eNSP Security Authentication 延伸
- **设备**：USG 防火墙 + 内外网路由器
- **目标**：按安全域划分接口，用安全策略控制域间流量，配置 NAT 与服务器映射

**配置顺序**

1. **划分安全域** — 把接口加入 trust/untrust/dmz 域，接口必须先 firewall zone 再配策略
   - 验证：`display zone`
2. **写安全策略** — security-policy 按源/目的域 + 地址 + 服务放行；默认动作是 deny
   - 验证：`display security-policy`
3. **配 NAT** — trust 到 untrust 用 nat-policy 做源 NAT；服务器发布用 nat server
   - 验证：`display nat-policy`
4. **验证域间** — trust 到 untrust 通、untrust 到 trust 默认不通；策略计数应增长
   - 验证：`display security-policy statistics`

**易错点**

- 同域内（intra-zone）流量不匹配域间安全策略，用策略做同域隔离不会生效
- 接口没加进域时所有流量都被丢弃，且日志里只显示无匹配域
- 策略顺序从上到下匹配，宽泛规则放前面会让后面的精确规则永远不命中
- NAT 与安全策略是两套独立匹配，NAT 放行了不等于策略放行

**拓扑蓝图**

- 设备：FW1 (USG6000V)、R-TRUST (AR2220)、R-UNTRUST (AR2220)、SRV1 (Server)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R-TRUST | GigabitEthernet0/0/0 | 10.1.1.254/24 | trust 侧（接防火墙） |
| FW1 | GigabitEthernet1/0/0 | 10.1.1.1/24 | trust 区域 |
| FW1 | GigabitEthernet1/0/1 | 200.1.1.1/24 | untrust 区域 |
| R-UNTRUST | GigabitEthernet0/0/0 | 200.1.1.2/24 | 外网侧 |
| FW1 | GigabitEthernet1/0/2 | 10.1.40.1/24 | dmz 区域 |
| SRV1 | Ethernet0/0/1 | 10.1.40.10/24 | 对外发布的服务器 |

生成：`ensp preset firewall-zones --topo firewall-zones.topo`
- 设备镜像：USG6000V 需要 eNSP 安装时勾选 USG6000V 组件（NGFW 镜像，约 1 GB）。缺镜像时 eNSP 会打开拓扑后自行退出，`ensp up` 会在启动前直接报错说明缺什么。

### bfd-fast-convergence — BFD 快速故障检测

- **英文名**：BFD fast failure detection
- **来源**：eNSP 常规实验
- **设备**：2~3 台路由器
- **目标**：用毫秒级 BFD 会话替代秒级的协议 Hello 超时，缩短收敛时间

**配置顺序**

1. **先建底层可达** — BFD 只做检测，不负责转发；直连或已有路由必须先通
2. **配 BFD 会话** — bfd 全局开启后，单跳用 bfd bind peer-ip；多跳需 bfd multi-hop
   - 验证：`display bfd session all`
3. **调检测参数** — min-tx-interval / min-rx-interval / detect-multiplier，两端取大值协商
4. **挂到协议上** — 静态路由 bfd enable，或 OSPF/VRRP 的 bfd 联动
   - 验证：`display bfd session all verbose`
5. **验证收敛** — 断开链路后 BFD 应在百毫秒级 Up→Down，路由表随之切换

**易错点**

- 检测间隔设得过小（如 3.3ms）在 eNSP 里会因调度抖动误报 Down
- 两端参数不一致时按较大值协商，实际收敛比预期慢
- BFD 会话 Up 但协议没联动，等于白配
- 多跳 BFD 要显式指定 multi-hop，否则默认单跳会话起不来

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 |  |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 |  |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 |  |
| R1 | GigabitEthernet0/0/1 | 10.0.13.1/24 |  |
| R3 | GigabitEthernet0/0/1 | 10.0.13.3/24 |  |
| R1 | LoopBack0 | 1.1.1.1/32 |  |
| R3 | LoopBack0 | 3.3.3.3/32 |  |

生成：`ensp preset bfd-fast-convergence --topo bfd-fast-convergence.topo`

### mpls-basic — MPLS 标签转发

- **英文名**：MPLS label switching
- **来源**：eNSP 常规实验
- **设备**：3~4 台路由器
- **目标**：建立 LSP，观察标签分配、压入、交换与弹出

**配置顺序**

1. **开 MPLS 与 LSR-ID** — 全局 mpls lsr-id 唯一，接口下 mpls 与 mpls ldp
   - 验证：`display mpls ldp peer`
2. **建 LDP 会话** — 两端接口都要开 mpls，LDP 用 UDP 646 建会话、TCP 646 传标签
   - 验证：`display mpls ldp session`
3. **看标签分配** — 每条 IGP 路由被分配一个入标签与出标签
   - 验证：`display mpls lsp`
4. **验证转发** — tracert 或 display mpls lsp 确认报文按标签而非 IP 逐跳转发

**易错点**

- 接口未开 mpls 时 LDP 邻居起不来，且路由本身照常工作，容易误判 MPLS 已生效
- LSR-ID 重复会导致 LDP 会话反复建立又断开
- 标签只在 LSP 上有效，LSP 断裂后回退到 IP 转发，现象是“能通但标签没了”
- eNSP 部分低端型号不支持 MPLS，配命令时会直接报错

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、R3 (AR2220)、R4 (AR2220)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | LoopBack0 | 1.1.1.1/32 | LSR-ID |
| R2 | LoopBack0 | 2.2.2.2/32 |  |
| R3 | LoopBack0 | 3.3.3.3/32 |  |
| R4 | LoopBack0 | 4.4.4.4/32 |  |
| R1 | GigabitEthernet0/0/0 | 10.0.12.1/24 |  |
| R2 | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| R2 | GigabitEthernet0/0/1 | 10.0.23.2/24 |  |
| R3 | GigabitEthernet0/0/0 | 10.0.23.3/24 |  |
| R3 | GigabitEthernet0/0/1 | 10.0.34.3/24 |  |
| R4 | GigabitEthernet0/0/0 | 10.0.34.4/24 |  |

生成：`ensp preset mpls-basic --topo mpls-basic.topo`

### mpls-l3vpn — BGP/MPLS L3VPN

- **英文名**：BGP/MPLS L3VPN
- **来源**：eNSP 常规实验（HCIP 范围）
- **设备**：5~6 台路由器（PE/P/CE）
- **目标**：两个站点私网通过运营商 MPLS 骨干互通，地址可重叠

**配置顺序**

1. **骨干先通** — P 与 PE 之间 IGP + MPLS LDP 全部就绪
   - 验证：`display mpls ldp session`
2. **PE 上建 VRF** — ip vpn-instance 绑定 RD 与 RT，接口划入 VRF
   - 验证：`display ip vpn-instance`
3. **PE-CE 路由** — 静态或 OSPF 把站点路由引入 VRF
4. **MP-BGP 传 VPNv4** — PE 间建 IBGP 并开 vpnv4 地址族，配 VPN target 控制导入导出
   - 验证：`display bgp vpnv4 all routing-table`
5. **验证隔离与互通** — 同 VPN 站点互通；不同 VPN 即使地址相同也互不可见

**易错点**

- RD 只保证唯一性不影响选路，真正控制导入导出的是 RT
- PE 间 IBGP 未开 vpnv4 地址族时 VPN 路由根本不传递
- VRF 接口没绑定 vpn-instance，站点路由进不了 VPN 表
- RT 配成 import 与 export 不一致是最常见的“单通”原因

**拓扑蓝图**

- 设备：PE1 (AR2220)、P (AR2220)、PE2 (AR2220)、CE1 (AR2220)、CE2 (AR2220)
- 链路：4 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| PE1 | LoopBack0 | 1.1.1.1/32 | MP-BGP 的 router-id |
| P | LoopBack0 | 2.2.2.2/32 |  |
| PE2 | LoopBack0 | 3.3.3.3/32 |  |
| PE1 | GigabitEthernet0/0/0 | 10.0.12.1/24 | 骨干 |
| P | GigabitEthernet0/0/0 | 10.0.12.2/24 |  |
| P | GigabitEthernet0/0/1 | 10.0.23.2/24 |  |
| PE2 | GigabitEthernet0/0/0 | 10.0.23.3/24 |  |
| PE1 | GigabitEthernet0/0/1 | 192.168.1.1/24 | VPN 实例 vrf-a |
| CE1 | GigabitEthernet0/0/0 | 192.168.1.10/24 |  |
| PE2 | GigabitEthernet0/0/1 | 192.168.1.2/24 | 同一地址空间，站点隔离 |
| CE2 | GigabitEthernet0/0/0 | 192.168.1.20/24 |  |

生成：`ensp preset mpls-l3vpn --topo mpls-l3vpn.topo`

### dual-homed-isp — 双出口多运营商选路

- **英文名**：Dual-homed ISP egress
- **来源**：eNSP 常规实验（HCIP 范围）
- **设备**：2 台出口路由器 + 2 个运营商 + 核心交换机
- **目标**：两条出口互为备份，按目的与业务分流，故障时自动切换

**配置顺序**

1. **两出口各自建默认路由** — 主出口 preference 60，备出口 preference 80，形成浮动备份
   - 验证：`display ip routing-table protocol static`
2. **按目的分流** — 用 ip-prefix 匹配不同运营商网段，各走各的出口，避免非对称回程
3. **挂 BFD 加速切换** — 两条默认路由 bfd enable，链路故障百毫秒级切走
   - 验证：`display bfd session all`
4. **NAT 与回程** — 两出口各自做 easy-ip；运营商侧回程路由必须指回对应出口地址
5. **验证主备与分流** — 断开主出口，走主出口的流量应切到备；tracert 确认不同目的走不同运营商

**易错点**

- 两条默认路由 preference 相同会形成 ECMP，一半流量走不可用出口
- 两出口都做 NAT 但只在一个出口配回程，切换后会出现单向不通
- 非对称回程（去走 A、回走 B）会被运营商或防火墙状态检测丢弃
- BFD 会话建在运营商链路上时要注意对端是否支持，不支持就退回路由协议检测

**拓扑蓝图**

- 设备：R1 (AR2220)、ISP1 (AR2220)、ISP2 (AR2220)、PC1 (PC)
- 链路：3 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/2 | 192.168.1.254/24 | 内网 |
| R1 | GigabitEthernet0/0/0 | 200.1.1.1/30 | ISP1 |
| ISP1 | GigabitEthernet0/0/0 | 200.1.1.2/30 |  |
| R1 | GigabitEthernet0/0/1 | 201.1.1.1/30 | ISP2 |
| ISP2 | GigabitEthernet0/0/0 | 201.1.1.2/30 |  |
| ISP1 | LoopBack0 | 8.8.8.8/32 | 仅 ISP1 宣告，用于观察回程选路 |

生成：`ensp preset dual-homed-isp --topo dual-homed-isp.topo`

### firewall-hrp — 防火墙双机热备（HRP）

- **英文名**：Firewall HA with HRP
- **来源**：eNSP Security 延伸
- **设备**：2 台 USG 防火墙 + 上下行设备
- **目标**：主备防火墙同步会话与配置，主设备故障时业务不中断

**配置顺序**

1. **直连心跳口** — 两台之间用独立链路配 hrp interface 与对端 remote 地址，不要与业务口混用
   - 验证：`display hrp state`
2. **开 HRP 并定主备** — 一台 hrp enable，另一台 hrp enable + hrp standby-device
   - 验证：`display hrp state`
3. **同步内容** — hrp auto-sync 同步配置与连接表；hrp mirror session 同步状态化会话
4. **上下行做 VRRP** — 两台在上下行接口各跑一组 VRRP，主设备优先级高并 track 上行
   - 验证：`display vrrp`
5. **调 OSPF 代价** — hrp adjust ospf-cost enable 让备机对外发布更高 cost，避免流量被引到备机
6. **切换验证** — 断开主设备上行，会话应保持、业务不中断
   - 验证：`display hrp state / display session table`

**易错点**

- 两台都注入默认路由却没调 OSPF 代价，会形成 ECMP，一半流量打到不转发的备机
- 心跳口与业务口共用链路时，主设备故障会连带心跳中断，备机可能误判
- 只同步配置不同步会话，切换后已建立的 TCP 连接全部中断，表现为“切换即掉线”
- HRP 要求两台型号、版本、接口编号一致，否则同步失败

**拓扑蓝图**

- 设备：FW1 (USG6000V)、FW2 (USG6000V)、R-UP (AR2220)、R-DOWN (AR2220)
- 链路：5 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| FW1 | GigabitEthernet1/0/0 | 10.1.250.1/24 | VRRP 组 350，虚拟 .253 |
| FW2 | GigabitEthernet1/0/0 | 10.1.250.2/24 | 备机同组 |
| FW1 | GigabitEthernet1/0/1 | 10.1.249.1/24 | VRRP 组 349，虚拟 .254 |
| FW2 | GigabitEthernet1/0/1 | 10.1.249.2/24 |  |
| FW1 | GigabitEthernet1/0/2 | 10.1.252.1/24 | HRP 心跳，直连 |
| FW2 | GigabitEthernet1/0/2 | 10.1.252.2/24 |  |
| R-UP | GigabitEthernet0/0/0 | 10.1.250.10/24 | 外网侧 |
| R-DOWN | GigabitEthernet0/0/0 | 10.1.249.10/24 | 内网侧 |

生成：`ensp preset firewall-hrp --topo firewall-hrp.topo`
- 设备镜像：USG6000V 需要 eNSP 安装时勾选 USG6000V 组件（NGFW 镜像，约 1 GB）。缺镜像时 eNSP 会打开拓扑后自行退出，`ensp up` 会在启动前直接报错说明缺什么。

### spine-leaf-vxlan — Spine-Leaf 与 VXLAN 大二层

- **英文名**：Spine-leaf with VXLAN overlay
- **来源**：eNSP 数据中心实验（依赖机型支持）
- **设备**：2 台 Spine + 2 台 Leaf + 服务器
- **目标**：用 VXLAN 在三层互联的 Underlay 上构建大二层 Overlay，虚拟机跨机架迁移

**配置顺序**

1. **先建 Underlay** — Spine-Leaf 之间 OSPF 或 BGP 打通，每台 Leaf 有 loopback 作 VTEP 地址
   - 验证：`display ip routing-table`
2. **建 NVE 接口** — interface nve 下 source 指向 VTEP 地址，配 vni 与头端复制列表
   - 验证：`display nve`
3. **建二层网关** — VNI 映射到 Bridge-Domain，BD 绑定 Vlanif 做网关
   - 验证：`display bridge-domain`
4. **配 EVPN 或静态头端** — EVPN 用 BGP evpn 地址族自动发现；静态则手工配 ingress-replication peer
5. **验证迁移** — 同网段服务器在不同 Leaf 下互通，IP 不变
   - 验证：`display vxlan vni`

**易错点**

- eNSP 多数交换机型不支持 VXLAN，命令直接报错，需先确认机型能力
- VTEP 地址必须用 loopback 且三层可达，用物理口地址会导致 Underlay 变化时隧道断
- BD 与 Vlanif 绑定关系配错时 VXLAN 通但网关不通
- EVPN 的 route-target 配反会导致本地 VNI 不导入远端路由

**拓扑蓝图**

- 设备：SPINE1 (S5700)、SPINE2 (S5700)、LEAF1 (S5700)、LEAF2 (S5700)、PC1 (PC)、PC2 (PC)
- 链路：6 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| SPINE1 | LoopBack0 | 10.0.255.11/32 | BGP 邻居 / VTEP 源 |
| SPINE2 | LoopBack0 | 10.0.255.12/32 |  |
| LEAF1 | LoopBack0 | 10.0.255.21/32 | VTEP |
| LEAF2 | LoopBack0 | 10.0.255.22/32 |  |
| LEAF1 | Vlanif10 | 192.168.10.252/24 | 分布式网关 |
| LEAF2 | Vlanif10 | 192.168.10.253/24 |  |

生成：`ensp preset spine-leaf-vxlan --topo spine-leaf-vxlan.topo`

### ipsec-gre-tunnel — IPsec 与 GRE 隧道组合

- **英文名**：IPsec over GRE and tunnel backup
- **来源**：eNSP HCNA Lab 3-4 延伸
- **设备**：2 台出口路由器
- **目标**：GRE 承载组播/动态路由，IPsec 保护它；或两条隧道互为备份

**配置顺序**

1. **先建 GRE 隧道** — tunnel 接口指定 source/destination 与 tunnel 地址，两端地址同网段
   - 验证：`display interface Tunnel`
2. **在隧道上跑路由** — 隧道口宣告进 OSPF，让两端私网通过隧道学到对方路由
   - 验证：`display ospf peer`
3. **用 IPsec 保护 GRE** — 感兴趣流写 GRE 两端公网地址之间的协议 47，套 ipsec policy
   - 验证：`display ipsec sa`
4. **备选：两条隧道浮动** — 两条 tunnel 配不同 cost/preference，主隧道断时切备
5. **验证** — display ipsec sa 有加密统计；断开主链路后流量走备隧道

**易错点**

- IPsec 感兴趣流的协议写错（写成 ip 或 tcp）会导致 GRE 报文不被加密
- GRE 本身不加密，只 IPsec 保护才是安全的；只配 GRE 等于明文隧道
- 隧道两端地址不在同网段时隧道 up 但路由不通
- GRE 会增加 24 字节开销，MTU 未调会导致大包被丢（表现为能 ping 通但网页打不开）

**拓扑蓝图**

- 设备：R1 (AR2220)、R2 (AR2220)、ISP (AR2220)
- 链路：2 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| R1 | GigabitEthernet0/0/0 | 100.1.1.1/30 | 公网侧 |
| ISP | GigabitEthernet0/0/0 | 100.1.1.2/30 |  |
| ISP | GigabitEthernet0/0/1 | 100.2.2.2/30 |  |
| R2 | GigabitEthernet0/0/0 | 100.2.2.1/30 |  |
| R1 | Tunnel0/0/0 | 10.1.1.1/24 | GRE over IPsec |
| R2 | Tunnel0/0/0 | 10.1.1.2/24 |  |

生成：`ensp preset ipsec-gre-tunnel --topo ipsec-gre-tunnel.topo`

### wlan-roaming — WLAN 漫游与 AC 高可用

- **英文名**：WLAN roaming and AC redundancy
- **来源**：eNSP WLAN 实验延伸
- **设备**：2 台 AC（或 1 AC + 多 AP）+ 交换机
- **目标**：终端在 AP 间移动时不断线，AC 故障时 AP 重新上线

**配置顺序**

1. **AP 上线** — 所有 AP 拿到管理地址并成功注册到 AC
   - 验证：`display ap all`
2. **统一 SSID 与安全模板** — 同一 SSID、同一安全策略、同一 VLAN 才能二层漫游
3. **开漫游** — 同一 AC 内默认支持；跨 AC 需配漫游组与 AC 间隧道
   - 验证：`display station roam-track`
4. **AC 备份** — AP 配主备 AC 地址，主 AC 故障后 AP 切到备 AC 重新上线
5. **验证漫游** — 终端移动时看 roam-track 记录，ping 应基本不丢包

**易错点**

- 不同 SSID 或不同安全模板无法漫游，终端会先断再连
- 跨 AC 漫游未建漫游组时终端会重新认证，表现为断线几秒
- AP 主备 AC 地址配了但 AC 间路由不通，主 AC 挂后备 AC 也拉不起 AP
- 漫游要求 VLAN 在二层连续，跨三层需要隧道或 VXLAN

**拓扑蓝图**

- 设备：AC (AC6005)、SW1 (S5700)、SW2 (S5700)、AP1 (AP6050)、AP2 (AP6050)、PC1 (PC)
- 链路：4 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| AC | Vlanif100 | 192.168.100.1/24 | CAPWAP 源 |
| AC | Vlanif50 | 192.168.50.254/24 | 业务网关（漫游域） |
| SW1 | Vlanif100 | 192.168.100.252/24 |  |
| SW2 | Vlanif100 | 192.168.100.253/24 |  |

生成：`ensp preset wlan-roaming --topo wlan-roaming.topo`

### campus-network — 园区网综合（双核心 + 接入 + 出口）

- **英文名**：Campus network (dual core, access, edge)
- **来源**：eNSP Campus_Network
- **设备**：10+ 台设备
- **目标**：把 VLAN、MSTP、VRRP、OSPF、NAT、ACL 组合成可运行园区网

**配置顺序**

1. **先二层后三层** — VLAN/Trunk/聚合先通，再上 Vlanif 与路由
   - 验证：`display vlan`
2. **网关冗余** — 核心间 VRRP，优先级配合 track 上行口
   - 验证：`display vrrp`
3. **路由** — 核心到出口 OSPF 或静态，出口默认路由
   - 验证：`display ip routing-table`
4. **边界** — NAT + ACL，内网出网与外网发布
   - 验证：`display nat session all`
5. **可靠性验证** — 逐项断开：核心、上行、出口、专线
   - 验证：`display vrrp / display stp brief`

**易错点**

- 先配三层再配二层会导致 Vlanif 反复 up/down
- 双核心未做 VRRP 优先级与 track 会产生双主

**拓扑蓝图**

- 设备：CORE1 (S5700)、CORE2 (S5700)、ACC1 (S5700)、ACC2 (S5700)、EDGE1 (AR2220)、EDGE2 (AR2220)、FW1 (USG6000V)、SRV-SW (S5700)、SRV1 (Server)、PC1 (PC)、PC2 (PC)
- 链路：14 条

| 设备 | 接口 | 地址 | 说明 |
| --- | --- | --- | --- |
| CORE1 | Vlanif10 | 10.1.10.252/24 | PC 网段网关（VRRP 主） |
| CORE2 | Vlanif10 | 10.1.10.253/24 | VRRP 备 |
| CORE1 | Vlanif20 | 10.1.20.252/24 |  |
| CORE2 | Vlanif20 | 10.1.20.253/24 |  |
| CORE1 | Vlanif31 | 10.1.31.1/24 | 设备管理网段 |
| CORE2 | Vlanif31 | 10.1.31.2/24 |  |
| EDGE1 | GigabitEthernet0/0/0 | 10.1.31.11/24 | 出口到核心 |
| EDGE2 | GigabitEthernet0/0/0 | 10.1.31.12/24 |  |
| EDGE1 | GigabitEthernet0/0/1 | 10.1.250.1/24 | 出口到防火墙（内外两段） |
| EDGE2 | GigabitEthernet0/0/1 | 10.1.250.2/24 |  |
| FW1 | GigabitEthernet1/0/0 | 10.1.249.1/24 | trust 区域 |
| FW1 | GigabitEthernet1/0/1 | 10.1.250.254/24 | untrust 区域 |
| FW1 | GigabitEthernet1/0/2 | 10.1.40.1/24 | dmz 区域 |
| SRV1 | Ethernet0/0/1 | 10.1.40.10/24 | 对外发布服务器 |

生成：`ensp preset campus-network --topo campus-network.topo`
- 设备镜像：USG6000V 需要 eNSP 安装时勾选 USG6000V 组件（NGFW 镜像，约 1 GB）。缺镜像时 eNSP 会打开拓扑后自行退出，`ensp up` 会在启动前直接报错说明缺什么。
