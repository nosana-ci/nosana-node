#!/usr/bin/env -S node --no-warnings
/// <reference path="./global.d.ts" />

import { pkg } from './static/index.js';
import { startCLI } from './cli/index.js';

const VERSION: string = pkg.version;

startCLI(VERSION).catch((e) => {
  console.error(e);
  process.exit(1);
});

export * from './cli/createNosanaCli.js';