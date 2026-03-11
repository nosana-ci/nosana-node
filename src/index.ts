#!/usr/bin/env -S node --no-warnings
/// <reference path="./global.d.ts" />

import http from 'http';
import https from 'https';
import { setDefaultResultOrder } from 'dns';
import CacheableLookup from 'cacheable-lookup';

import { pkg } from './static/index.js';
import { startCLI } from './cli/index.js';

const VERSION: string = pkg.version;

setDefaultResultOrder('ipv4first');

const cacheable = new CacheableLookup();
cacheable.install(http.globalAgent);
cacheable.install(https.globalAgent);

startCLI(VERSION);

export * from './cli/createNosanaCli.js';