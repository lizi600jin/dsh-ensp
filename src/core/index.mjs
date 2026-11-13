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
  MODEL_NAMES,
  GEOMETRY,
  ICON,
  vrpToFlatIndex,
  flatIndexToVrp,
  portCount,
  describePorts,
  portsFromDeclarations,
  declarationsFor,
} from './models.mjs'

// Kept for consumers written against the old shape; the table behind it was
// wrong (S3700 as 24 Ethernet ports, AR1220 as 8 GE ports) and has been
// replaced by the measured one in models.mjs.
export { MODEL_NAMES as MODELS } from './models.mjs'

export {
  buildTopology,
  autoLayout,
  twoPcLab,
  twoPcLabConfig,
} from './build.mjs'

export {
  interfaceName,
  interfaceIndex,
  parseTopology,
  readTopology,
  writeTopology,
  serialiseTopology,
  summarise,
} from './topology.mjs'

export {
  LABS,
  LAB_IDS,
  hasLab,
  buildScenarioTopology,
  labAddressing,
  labDevices,
  labModels,
} from './labs.mjs'

export {
  probeDevice,
  checkTopologySupport,
  describeBlocked,
  imageNotesFor,
  IMAGE_NOTES,
  rootFromExe,
} from './compat.mjs'

export {
  doctor,
  formatDoctor,
  checkEnvironment,
  probeInputInjection,
  freeMemoryMb,
  busyConsolePorts,
  modelsOf,
  MIN_FREE_MEMORY_MB,
} from './doctor.mjs'

export {
  EXPECTATIONS,
  evaluateAssertion,
  planFor,
  resolveDevice,
  hasChecks,
  consolePorts,
  runAcceptance,
  formatAcceptance,
} from './acceptance.mjs'

export { ConsoleSession, openConsole, probeConsole, viewOf, hostnameOf, hasPagerMarker } from './console.mjs'

export {
  enspPid,
  locateWindow,
  launchEnsp,
  focusEnsp,
  minimiseEnsp,
  clickToolbar,
  checkOcclusion,
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

export {
  pushConfig,
  pushConfigMany,
  queryDevice,
  parseScript,
  waitForOutput,
  waitForOspfFull,
  waitForOspfRoute,
} from './provision.mjs'

export {
  SCENARIOS,
  SCENARIO_IDS,
  byLevel,
  renderScenario,
  searchScenarios,
} from './presets.mjs'

export {
  knowledgeTopics,
  knowledgeFor,
  searchKnowledge,
  renderKnowledge,
} from './knowledge.mjs'

export {
  curriculumLevels,
  curriculumChapters,
  curriculumFor,
  searchCurriculum,
  renderCurriculum,
} from './curriculum.mjs'

export {
  resolveEnspExe,
  resolveVBoxManage,
  resolveEnspRoot,
  probePaths,
  enspCandidates,
  vboxCandidates,
} from './paths.mjs'
