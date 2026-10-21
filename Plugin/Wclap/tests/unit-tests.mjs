// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the Wasm build of upstream's unit tests (build-wclap/wclap/unit-tests.wasm)
// under Node's WASI: node tests/unit-tests.mjs [TestName...]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WASI} from 'node:wasi';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.CHOWTAPE_UNIT_TESTS || path.resolve(here, '../../../build-wclap/wclap/unit-tests.wasm');
const wasi = new WASI({version: 'preview1', args: ['unit-tests', ...process.argv.slice(2)], env: {HOME: '/'}, returnOnExit: true});
const module = await WebAssembly.compile(fs.readFileSync(file));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
