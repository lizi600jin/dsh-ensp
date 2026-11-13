
# dsh-ensp

Automation for Huawei eNSP: generate topologies, boot devices, push configuration line by line, and verify the result of every command.

- Generates `.topo` files that eNSP opens directly, from a scenario blueprint (devices, links and addressing included) or from custom devices and links
- Locates the toolbar buttons to start and stop devices, confirms each device individually, then minimises the window
- Pushes configuration one command at a time; the first error aborts the batch and reports the line, the command and the device's raw output
- Ships 50 scenario presets covering VLAN, STP, stacking, link aggregation, routing, BGP, MPLS, multicast, NAT, ACL, QoS, IPsec, IPv6, WLAN, firewalls and high availability
- Checks that every device image is installed before launching, and names the missing component instead of letting eNSP open the topology and quit silently
- Runs seven preflight checks (images, ports, memory, input injection), each with a stated fix, then verifies the scenario against what the devices actually report
- Must run elevated, with the eNSP window visible (see the run-permissions section in the repository documentation)
- Each scenario points at the vendor manual chapter that teaches it, with that chapter's goals and the display commands it uses to prove the result; the index is searchable
- Usable as a CLI, an MCP server, or a DeepSeek Harness plugin

Full documentation: [repository](https://github.com/lizi600jin/dsh-ensp#readme).
