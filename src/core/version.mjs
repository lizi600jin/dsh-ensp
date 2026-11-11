/**
 * Single source of truth for the package version.
 *
 * Three places used to hard-code a version (the DSH plugin metadata, the MCP
 * server banner and package.json), and all three had drifted apart: 0.1.5,
 * 0.1.0 and 0.1.6 respectively. Reading package.json keeps them honest without
 * pulling in a build step.
 *
 * @module dsh-ensp/version
 */

import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

/** Version string, e.g. `0.1.6`. */
export const VERSION = pkg.version

/** Package name, e.g. `dsh-ensp`. */
export const PACKAGE_NAME = pkg.name
