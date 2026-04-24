#!/usr/bin/env -S node --no-warnings
/// <reference path="./global.d.ts" />

import { pkg } from './static/index.js';
import { startCLI } from './cli/index.js';

const VERSION: string = pkg.version;

startCLI(VERSION);

export * from './cli/createNosanaCli.js';