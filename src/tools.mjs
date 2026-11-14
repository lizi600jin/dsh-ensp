/**
 * The single tool table.
 *
 * Both front ends publish the same operations: the MCP server as JSON Schema
 * `inputSchema` objects, the DSH plugin as a flat `parameters` map. Keeping two
 * copies of the wording meant every behaviour change had to be written twice and
 * the two versions drifted in places nobody notices until a model reads the
 * wrong one.
 *
 * This module holds only what both sides must agree on: the tool name, one
 * description, and the parameter nodes as plain JSON Schema. It deliberately
 * holds no handlers: the two front ends return different shapes (MCP returns raw
 * objects, DSH returns rendered text blocks through a required `output` schema),
 * so the `run` / `execute` implementations stay with their own adapter.
 *
 * @module dsh-ensp/tools
 */

import { MODEL_SPECS } from './core/build.mjs'
import { SCENARIO_IDS } from './core/presets.mjs'

/**
 * Every tool this package publishes, in publication order.
 *
 * `params` is a flat field map: the key is the argument name and the value is the
 * JSON Schema node for that argument. Enumerations and nested object shapes are
 * written inline as ordinary schema nodes.
 */
export const TOOL_SPECS = [
  {
    name: 'ensp_status',
    description:
      'Report eNSP state: whether the client is running, its window handle, and the calibrated toolbar anchors. '
      + 'With a topology path, also polls every device console and reports which ones answer VRP.',
    params: {
      topology: { type: 'string', description: 'Optional .topo path; when set, each console is probed (max 4s each).' },
    },
  },
  {
    name: 'ensp_build_topology',
    description:
      'Generate a .topo file eNSP can open. Use preset "two-pc" for the built-in two-PC/one-switch lab, '
      + 'scenario to build the topology behind a scenario id, or pass devices and links explicitly '
      + '(links use VRP interface names such as GigabitEthernet0/0/0). Returns the written path and a summary.',
    params: {
      path: { type: 'string', description: 'Output .topo path.' },
      preset: { type: 'string', enum: ['two-pc'], description: '"two-pc" for the built-in lab.' },
      scenario: { type: 'string', description: 'Scenario id with a topology blueprint, e.g. "ospf-single".' },
      vlan: { type: 'number', description: 'VLAN id for the two-pc preset (default 10).' },
      subnet: { type: 'string', description: 'for preset two-pc (default 192.168.10)' },
      devices: {
        type: 'array',
        description: 'Device list: [{ name, model, x, y }].',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            model: { type: 'string', enum: Object.keys(MODEL_SPECS) },
            x: { type: 'number' },
            y: { type: 'number' },
            pc: { type: 'object', properties: { ip: { type: 'string' }, gateway: { type: 'string' } } },
          },
        },
      },
      links: {
        type: 'array',
        description: 'Link list: [{ a, aPort, b, bPort }]; ports use VRP interface names.',
        items: {
          type: 'object',
          properties: {
            a: { type: 'string' },
            aPort: { type: 'string' },
            b: { type: 'string' },
            bPort: { type: 'string' },
          },
        },
      },
    },
  },
  {
    name: 'ensp_open',
    description:
      'Launch eNSP (or reuse the running instance) and open a topology file. '
      + 'Returns the process id and window handle needed by the other tools.',
    params: {
      topology: { type: 'string', description: 'Absolute path to a .topo file.' },
    },
  },
  {
    name: 'ensp_start',
    description:
      'Boot every device in a topology. Calibrates the toolbar by colour, clicks start, then polls each '
      + 'console until VRP answers, so readiness is measured per device rather than assumed. The window is '
      + 'minimised afterwards unless keepWindow is true.',
    params: {
      topology: { type: 'string', description: 'Absolute path to the .topo file that is currently open.' },
      hwnd: { type: 'string', description: 'optional; located automatically' },
      perDeviceTimeoutMs: { type: 'number', description: 'Per-device readiness ceiling in ms (default 240000).' },
      keepWindow: { type: 'boolean', description: 'Leave the eNSP window visible after starting.' },
    },
  },
  {
    name: 'ensp_stop',
    description: 'Shut down every device in the running topology.',
    params: {
      hwnd: { type: 'string', description: 'optional; located automatically' },
    },
  },
  {
    name: 'ensp_apply',
    description:
      'Push a configuration script to one device, one command at a time. Each command is confirmed by its '
      + 'prompt before the next is sent; the first error aborts the batch and reports the line, the command '
      + 'and the raw device output.',
    params: {
      device: { type: 'string', description: 'Device name, used in the report.' },
      port: { type: 'number', description: 'Console TCP port from the .topo file.' },
      script: { type: 'string', description: 'Configuration text; blank lines and ! / # comments are skipped.' },
      save: { type: 'boolean', description: 'Run save at the end.' },
    },
  },
  {
    name: 'ensp_apply_dir',
    description:
      'Push one .cfg per device from a directory, matching file names to device names. Devices are '
      + 'configured concurrently and one failure does not stop the others.',
    params: {
      directory: { type: 'string', description: 'Directory containing <device>.cfg files.' },
      topology: { type: 'string', description: 'Topology that maps device names to console ports.' },
      save: { type: 'boolean', description: 'Run save on each device afterwards.' },
      concurrency: { type: 'number', description: 'How many devices to configure at once (default 3).' },
    },
  },
  {
    name: 'ensp_query',
    description: 'Run one read-only command on a device console and return its output.',
    params: {
      port: { type: 'number', description: 'Console TCP port.' },
      command: { type: 'string', description: 'One VRP command, e.g. "display ip routing-table".' },
    },
  },
  {
    name: 'ensp_probe',
    description:
      'Re-measure the toolbar anchors and report every colour cluster. Run this after an eNSP upgrade or a '
      + 'change of display scaling; results are cached per window size otherwise.',
    params: {
      hwnd: { type: 'string', description: 'optional; located automatically' },
    },
  },
  {
    name: 'ensp_show',
    description:
      'Bring the eNSP window back to the front. Use it after ensp_start minimised the window and you want to '
      + 'watch the lab while it is being configured. Reports whether the window was restored out of the '
      + 'taskbar and whether it ended up in front.',
    params: {
      hwnd: { type: 'string', description: 'optional; located automatically' },
    },
  },
  {
    name: 'ensp_scenarios',
    description:
      'List or search the built-in configuration scenarios (' + SCENARIO_IDS.length + ' of them, mirroring the labs '
      + 'shipped with eNSP plus verified project scenarios). Each entry is a skeleton: what to create, in what '
      + 'order, and the command that proves it worked, rather than a command dump. Pass syllabus instead to '
      + 'search the vendor manual chapter index: where a topic is taught, and which display command that '
      + 'chapter uses to prove its result.',
    params: {
      search: { type: 'string', description: 'Keyword filter, e.g. "ospf" or "vlan".' },
      level: { type: 'string', enum: ['basic', 'intermediate', 'advanced'], description: 'One of basic, intermediate, advanced.' },
      syllabus: { type: 'string', description: 'Keyword to search the vendor manual chapter index, e.g. "MPLS".' },
    },
  },
  {
    name: 'ensp_scenario',
    description:
      'Return one scenario as a step-by-step brief: ordered direction, the verification command for each '
      + 'step, and the known pitfalls. Use this to plan a configuration before touching any device.',
    params: {
      id: { type: 'string', description: 'Scenario id, e.g. "ospf-single".' },
    },
  },
  {
    name: 'ensp_images',
    description:
      'Report which plugin device images this installation has, and install one where it is needed. '
      + 'Plugin models (USG6000V, NE40E, NE5000E, NE9000, CX, CE6800, CE12800) ship an image that the '
      + 'eNSP installer may not have included: the client then opens a topology that uses them, renders it, '
      + 'and quits by itself. The destination path is read from the model\'s own VirtualBox template, so it '
      + 'is correct on any machine. Call with no arguments to see what is missing; pass model and source to '
      + 'install one.',
    params: {
      model: { type: 'string', description: 'plugin model, e.g. "USG6000V"; omit to list every one' },
      source: { type: 'string', description: 'path to the image file to install for that model' },
      overwrite: { type: 'boolean', description: 'replace an image that is already in place' },
    },
  },
  {
    name: 'ensp_doctor',
    description:
      'Check whether this machine can actually run a lab before starting anything: eNSP and '
      + 'VirtualBox presence, missing device images, console ports already in use, free memory, and '
      + 'whether synthetic mouse input reaches this session at all. Every failing check comes with a '
      + 'fix. Never starts eNSP, so it is safe to run first.',
    params: {
      topology: { type: 'string', description: 'optional .topo path, so the device images it needs can be checked' },
      deep: { type: 'boolean', description: 'run the slow input-injection probe (default true)' },
    },
  },
  {
    name: 'ensp_verify',
    description:
      'Run a scenario\'s acceptance checks against a lab that is already running. Curated scenarios '
      + 'assert on what each device reports (OSPF Full, BGP Established, VRRP Master); the rest '
      + 'only run each verification command and cannot check its output, which the summary reports '
      + 'as unverified (ok is null) rather than passed.',
    params: {
      scenario: { type: 'string', description: 'scenario id, e.g. "ospf-single"' },
      topology: { type: 'string', description: 'the .topo file that is running, used for console ports' },
      timeout: { type: 'number', description: 'per-command timeout in ms (default 25000)' },
      wait: { type: 'number', description: 'how long a failing assertion may keep being retried, in ms (default 60000)' },
    },
  },
  {
    name: 'ensp_preset_config',
    description:
      'Return configuration text. Without a scenario it is the built-in two-PC lab; with one it is that scenario blueprint addressing plan, which covers interfaces and addresses only, so routing and policy still come from the scenario steps.',
    params: {
      vlan: { type: 'number', description: 'VLAN id for the two-PC lab (default 10).' },
      scenario: {
        type: 'string',
        description: 'Scenario id whose addressing plan to emit instead of the two-PC lab.',
        enum: SCENARIO_IDS,
      },
    },
  },
  {
    name: 'ensp_report',
    description:
      'Write a Word (.docx) delivery report for one scenario of a running lab. It reads each device\'s running '
      + 'configuration, reruns the acceptance checks and keeps their full output, then lays it out in six '
      + 'chapters: purpose, topology and addressing, configuration, verification, problems and conclusion, '
      + 'appendix. The verdict at the top is the same three-state verdict ensp_verify gives, so a lab whose '
      + 'checks had no assertion is reported as unverified rather than passed.',
    params: {
      scenario: { type: 'string', description: 'scenario id, e.g. "ospf-single"', enum: SCENARIO_IDS },
      topology: { type: 'string', description: 'the .topo file that is running, used for devices and console ports' },
      out: { type: 'string', description: 'where to write the .docx (default "<scenario>-report.docx")' },
      timeout: { type: 'number', description: 'per-command timeout in ms (default 25000)' },
      wait: { type: 'number', description: 'how long a failing assertion may keep being retried, in ms (default 60000)' },
    },
  },
]

/** Registry-time name list, in publication order. */
export const TOOL_NAMES = TOOL_SPECS.map((t) => t.name)

/**
 * Build a closed JSON Schema object for MCP's `inputSchema`.
 *
 * The properties are deep-copied so neither front end can mutate the shared
 * table, and `required` stays empty: the two adapters disagree about which
 * arguments are mandatory, and their handlers already report a missing one with
 * a message that names it.
 *
 * @param {object} params - flat field map from a `TOOL_SPECS` entry
 */
export function toInputSchema(params) {
  return { type: 'object', properties: structuredClone(params), required: [] }
}
