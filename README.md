# dsh-ensp

Automate Huawei eNSP labs end to end: build topology, boot devices, push config with per-command verification.

`dsh-ensp` drives Huawei eNSP (Enterprise Network Simulation Platform) so a whole lab — topology, device boot, configuration, verification — can be reproduced from a script instead of by hand.

It is usable in three ways:

- **CLI** — run lab steps from a terminal or a shell script.
- **MCP server** — expose the same operations as tools an MCP-capable agent can call.
- **DeepSeek Harness plugin** — load it into DSH as a plugin and let the agent build and configure labs directly.

## Status

🚧 Under active development (v0.1.0)

## License

MIT
