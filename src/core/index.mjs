/**
 * Public API of dsh-ensp.
 *
 * One import surface for the CLI, the MCP server and the Harness plugin, so a
 * behavioural change lands everywhere at once.
 *
 * @module dsh-ensp
 */

export {
  MODEL_SPECS,
  buildTopology,
  autoLayout,
  twoPcLab,
  twoPcLabConfig,
  vrpToFlatIndex,
} from './build.mjs'

export {
  MODELS,
  GEOMETRY,
  interfaceName,
  interfaceIndex,
  parseTopology,
  readTopology,
  writeTopology,
  serialiseTopology,
  summarise,
} from './topology.mjs'

export { ConsoleSession, openConsole, probeConsole, viewOf, hostnameOf } from './console.mjs'

export {
  enspPid,
  locateWindow,
  launchEnsp,
  focusEnsp,
  minimiseEnsp,
  clickToolbar,
  waitForConsole,
  startAllDevices,
  stopAllDevices,
} from './launcher.mjs'

export {
  calibrateAnchors,
  inspectAnchors,
  resetCalibrationCache,
  DEFAULT_ANCHORS,
} from './calibrate.mjs'

export { pushConfig, pushConfigMany, queryDevice, parseScript } from './provision.mjs'

export {
  SCENARIOS,
  SCENARIO_IDS,
  byLevel,
  renderScenario,
  searchScenarios,
} from './presets.mjs'
