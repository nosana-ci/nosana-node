#!/usr/bin/env -S node --no-warnings
/// <reference path="./global.d.ts" />

import { pkg } from './static/index.js';
import { startCLI } from './cli/index.js';
import { tolerateBrokenStdio } from './NodeManager/utils/tolerateBrokenStdio.js';

const VERSION: string = pkg.version;

// Before anything can write: the first console call happens inside startCLI.
tolerateBrokenStdio();

startCLI(VERSION);

export * from './cli/createNosanaCli.js';
