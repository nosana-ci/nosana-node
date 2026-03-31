#!/usr/bin/env -S node --no-warnings
/// <reference path="./global.d.ts" />

import http from 'http';
import https from 'https';
import { setDefaultResultOrder } from 'dns';

import { pkg } from './static/index.js';
import { startCLI } from './cli/index.js';

const VERSION: string = pkg.version;

setDefaultResultOrder('ipv4first');

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

http.globalAgent = httpAgent;
https.globalAgent = httpsAgent;

startCLI(VERSION);

export * from './cli/createNosanaCli.js';