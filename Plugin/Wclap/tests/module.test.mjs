// SPDX-License-Identifier: GPL-3.0-or-later
// The CHOWTapeModel WCLAP module in Node: its CLAP surface against the desktop CLAP's,
// audio, state, the webview protocol, presets, the user folder and mix groups.
//   node --test tests/module.test.mjs        (after scripts/build.sh and scripts/package.py)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {WclapModule, EVENT} from '../host/clap-host.mjs';
import {memoryFiles, nodeFiles} from '../host/wasi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = process.env.CHOWTAPE_WCLAP_BUNDLE || path.resolve(here, '../../../build-wclap/chowtape.wclap');
const bytes = fs.readFileSync(path.join(bundle, 'module.wasm'));
const compiled = await WebAssembly.compile(bytes);
const ID = 'org.chowdsp.CHOWTapeModel';
const RATE = 48000, BLOCK = 512;

// juce::String::hashCode: the desktop CLAP's parameter ids.
const juceHash = text => { let h = 0; for (const c of text) h = (Math.imul(h, 31) + c.codePointAt(0)) >>> 0; return h; };
const json = buffer => JSON.parse(new TextDecoder().decode(buffer));
const message = object => new TextEncoder().encode(JSON.stringify(object));

async function load(options = {}) {
  return WclapModule.load({module: compiled, files: await nodeFiles(bundle), seed: 7, ...options});
}

// A plug-in with an open editor page whose messages are collected.
function open(module, extra = {}) {
  const page = [], host = {restarts: 0, rescans: 0, callbacks: 0, logs: []};
  const plugin = module.createPlugin(ID, {
    webviewSend: buffer => { page.push(json(buffer)); return true; },
    requestRestart: () => { host.restarts++; },
    paramsRescan: () => { host.rescans++; },
    requestCallback: () => { host.callbacks++; },
    log: (severity, text) => host.logs.push(text),
    ...extra,
  });
  return {plugin, page, host};
}

function openEditor(plugin, page) {
  if (!plugin.process_) plugin.activate(RATE, 1, BLOCK);
  assert.ok(plugin.guiCreate());
  assert.ok(plugin.webviewReceive(message({type: 'hello'})));
  const init = page.find(m => m.type === 'init');
  assert.ok(init, 'the plug-in answers hello with init');
  return init;
}

const idOf = (init, key) => init.params.find(p => p.key === key).id >>> 0;
const sine = (frames, start = 0, frequency = 220, gain = 0.5) => {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; ++i) out[i] = gain * Math.sin(2 * Math.PI * frequency * (start + i) / RATE);
  return out;
};
const pump = plugin => { if (plugin.callbackPending) plugin.onMainThread(); };

test('the module imports only WASI and exports a CLAP entry', () => {
  const imports = WebAssembly.Module.imports(compiled);
  assert.deepEqual([...new Set(imports.map(i => i.module))], ['wasi_snapshot_preview1']);
  const exports = WebAssembly.Module.exports(compiled).map(e => e.name);
  for (const name of ['clap_entry', 'malloc', 'free', 'memory', '__indirect_function_table', '_initialize'])
    assert.ok(exports.includes(name), name);
});

test('descriptor, parameters and ports match the desktop CLAP', async () => {
  const module = await load();
  const [descriptor] = module.descriptors();
  assert.equal(descriptor.id, ID);
  assert.equal(descriptor.name, 'CHOWTapeModel');
  assert.ok(descriptor.features.includes('audio-effect'));
  const {plugin, page} = open(module);
  const init = openEditor(plugin, page);
  assert.equal(plugin.paramCount(), init.params.length);
  for (let i = 0; i < plugin.paramCount(); ++i) {
    const info = plugin.paramInfo(i), entry = init.params[i];
    assert.equal(info.id, juceHash(entry.key), entry.key);
    assert.equal(info.id, entry.id >>> 0);
    if (entry.kind === 'choice') {
      // CLAP_USE_JUCE_PARAMETER_RANGES DISCRETE: choices in their JUCE range.
      assert.equal(info.min, 0, entry.key);
      assert.equal(info.max, entry.choices.length - 1, entry.key);
    } else {
      assert.equal(info.min, 0, entry.key);
      assert.equal(info.max, 1, entry.key);
    }
  }
  assert.deepEqual(plugin.audioPorts(true).map(p => [p.id, p.name, p.channels]), [[32768, 'Input', 2]]);
  assert.deepEqual(plugin.audioPorts(false).map(p => [p.id, p.name, p.channels]), [[1, 'Output', 2]]);
  const mode = plugin.paramInfo(init.params.findIndex(p => p.key === 'mode'));
  assert.equal(plugin.paramText(mode.id, 2), init.params.find(p => p.key === 'mode').choices[2]);
  assert.equal(plugin.paramFromText(idOf(init, 'ingain'), '-6 dB') < plugin.paramValue(idOf(init, 'ingain')), true);
  plugin.destroy();
});

test('it processes audio, and fully dry it is the input delayed by the reported latency', async () => {
  const module = await load();
  const {plugin, page} = open(module);
  const init = openEditor(plugin, page);
  const latency = plugin.latency();
  assert.ok(latency > 0 && latency < 1000, `latency ${latency}`);

  let sum = 0, count = 0;
  for (let b = 0; b < 40; ++b) {
    const x = sine(BLOCK, b * BLOCK);
    const out = plugin.process(BLOCK, {input: [x, x]});
    for (const v of out.left) assert.ok(Number.isFinite(v));
    if (b >= 10) for (const v of out.left) { sum += v * v; count++; }
  }
  const rms = Math.sqrt(sum / count);
  assert.ok(rms > 0.05 && rms < 1, `wet rms ${rms}`);

  // Dry/Wet 0: the dry path, delayed by a whole number of samples (latencyCompensation).
  plugin.flush([{type: EVENT.PARAM_VALUE, time: 0, id: idOf(init, 'drywet'), value: 0}]);
  const input = [], output = [];
  for (let b = 0; b < 60; ++b) {
    const x = sine(BLOCK, b * BLOCK, 440, 0.3);
    const out = plugin.process(BLOCK, {input: [x, x]});
    input.push(...x);
    output.push(...out.left);
  }
  let error = 0;
  for (let i = 40 * BLOCK; i < input.length; ++i) error = Math.max(error, Math.abs(output[i] - input[i - latency]));
  assert.ok(error < 1e-4, `dry path error ${error}`);
  plugin.destroy();
});

test('parameter events change the sound', async () => {
  const module = await load();
  const {plugin, page} = open(module);
  const init = openEditor(plugin, page);
  const render = events => {
    const out = [];
    for (let b = 0; b < 20; ++b) {
      const x = sine(BLOCK, b * BLOCK);
      out.push(...plugin.process(BLOCK, {input: [x, x], events: b === 0 ? events : []}).left);
    }
    return out.slice(10 * BLOCK);
  };
  const before = render([]);
  const after = render([{type: EVENT.PARAM_VALUE, time: 0, id: idOf(init, 'drive'), value: 1},
    {type: EVENT.PARAM_VALUE, time: 0, id: idOf(init, 'sat'), value: 1}]);
  assert.equal(plugin.paramValue(idOf(init, 'drive')), 1);
  const difference = Math.max(...before.map((v, i) => Math.abs(v - after[i])));
  assert.ok(difference > 0.01, `difference ${difference}`);
  plugin.destroy();
});

test('state is the desktop getStateInformation bytes and round-trips', async () => {
  const module = await load();
  const a = open(module), b = open(module);
  const init = openEditor(a.plugin, a.page);
  b.plugin.activate(RATE, 1, BLOCK);
  a.plugin.flush([
    {type: EVENT.PARAM_VALUE, time: 0, id: idOf(init, 'drive'), value: 0.9},
    {type: EVENT.PARAM_VALUE, time: 0, id: idOf(init, 'mode'), value: 2},
    {type: EVENT.PARAM_VALUE, time: 0, id: idOf(init, 'loss_onoff'), value: 0},
  ]);
  const state = a.plugin.saveState();
  // juce::AudioProcessor::copyXmlToBinary: magic, size, then the XML.
  assert.equal(new DataView(state.buffer).getUint32(0, true), 0x21324356);
  const xml = new TextDecoder().decode(state.subarray(8));
  assert.match(xml, /<state version="[0-9.]+"><Parameters>/);
  assert.match(xml, /<PARAM id="drive" value="0\.(9|8999)/);
  assert.ok(b.plugin.loadState(state));
  assert.ok(b.host.rescans > 0, 'the host is told to rescan');
  for (const key of ['drive', 'mode', 'loss_onoff'])
    assert.equal(b.plugin.paramValue(idOf(init, key)), a.plugin.paramValue(idOf(init, key)), key);
  a.plugin.destroy();
  b.plugin.destroy();
});

test('a state written by the desktop plug-in loads', async () => {
  const module = await load();
  const {plugin, page} = open(module);
  const init = openEditor(plugin, page);
  // copyXmlToBinary on a little-endian desktop machine.
  const xml = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><state version="2.11.4">'
    + '<Parameters><PARAM id="drive" value="0.33"/><PARAM id="mode" value="3.0"/></Parameters></state>');
  const bytes = new Uint8Array(8 + xml.length + 1);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x21324356, true);
  view.setUint32(4, xml.length + 1, true);
  bytes.set(xml, 8);
  assert.ok(plugin.loadState(bytes));
  assert.ok(Math.abs(plugin.paramValue(idOf(init, 'drive')) - 0.33) < 1e-6);
  assert.equal(plugin.paramValue(idOf(init, 'mode')), 3);
  plugin.destroy();
});

test('editor edits reach the host with gestures, and host changes reach the editor', async () => {
  const module = await load();
  const {plugin, page} = open(module);
  const init = openEditor(plugin, page);
  const drive = idOf(init, 'drive');
  page.length = 0;
  plugin.webviewReceive(message({type: 'gesture', id: drive, begin: true}));
  plugin.webviewReceive(message({type: 'param', id: drive, value: 0.75}));
  plugin.webviewReceive(message({type: 'gesture', id: drive, begin: false}));
  const reply = page.find(m => m.type === 'params');
  assert.deepEqual(reply.values[0].slice(0, 2), [init.params.find(p => p.key === 'drive').id, 0.75]);
  const events = plugin.flush([]);
  assert.deepEqual(events.map(e => e.type), [EVENT.PARAM_GESTURE_BEGIN, EVENT.PARAM_VALUE, EVENT.PARAM_GESTURE_END]);
  assert.equal(events[1].id, drive);
  assert.equal(events[1].value, 0.75);

  // A stepped parameter arrives at the host in its JUCE range.
  plugin.webviewReceive(message({type: 'param', id: idOf(init, 'mode'), value: 0.4}));
  const [mode] = plugin.flush([]);
  assert.equal(mode.value, 2);

  // Typed text, as the speed buttons send it.
  plugin.webviewReceive(message({type: 'paramText', id: idOf(init, 'speed'), text: '30'}));
  assert.equal(plugin.paramText(idOf(init, 'speed'), plugin.paramValue(idOf(init, 'speed'))), '30.00');
  plugin.flush([]);

  // Host automation is not echoed to the host, and the editor hears about it.
  page.length = 0;
  const echoed = plugin.flush([{type: EVENT.PARAM_VALUE, time: 0, id: drive, value: 0.25}]);
  assert.deepEqual(echoed, []);
  plugin.onMainThread();
  const update = page.find(m => m.type === 'params');
  assert.ok(update.values.some(([id, value]) => (id >>> 0) === drive && value === 0.25));
  plugin.destroy();
});

test('factory presets load from the editor', async () => {
  const module = await load();
  const {plugin, page} = open(module);
  const init = openEditor(plugin, page);
  assert.ok(init.presets.length >= 90, `${init.presets.length} presets`);
  assert.equal(init.preset.name, 'Default');
  const target = init.presets.find(p => p.name === 'LoFi');
  assert.ok(target);
  const before = init.params.map(p => plugin.paramValue(p.id >>> 0));
  page.length = 0;
  plugin.webviewReceive(message({type: 'preset', index: target.index}));
  const after = init.params.map(p => plugin.paramValue(p.id >>> 0));
  assert.ok(after.some((v, i) => v !== before[i]), 'the preset changes parameters');
  assert.equal(page.filter(m => m.type === 'preset').at(-1).name, 'LoFi');
  assert.ok(plugin.flush([]).some(e => e.type === EVENT.PARAM_VALUE), 'the host hears the new values');
  plugin.destroy();
});

test('user presets are saved in the host\'s user folder', async () => {
  const user = memoryFiles();
  const module = await load({user});
  const {plugin, page} = open(module);
  const init = openEditor(plugin, page);
  assert.equal(init.userFolder, true);
  plugin.webviewReceive(message({type: 'param', id: idOf(init, 'drive'), value: 0.6}));
  plugin.webviewReceive(message({type: 'savePreset', name: 'My Tape'}));
  plugin.onMainThread();
  const saved = user.read('/Presets/My Tape.chowpreset');
  assert.ok(saved, `saved files: ${[...user.entries.keys()].join(', ')}`);
  assert.match(new TextDecoder().decode(saved), /<Preset name="My Tape"/);
  const list = page.filter(m => m.type === 'presets').at(-1);
  assert.ok(list?.presets.some(p => p.name === 'My Tape' && p.user));
  assert.equal(page.filter(m => m.type === 'preset').at(-1).name, 'My Tape');
  plugin.destroy();

  // A new instance (a new session) lists it.
  const again = open(module);
  const reopened = openEditor(again.plugin, again.page);
  assert.ok(reopened.presets.some(p => p.name === 'My Tape' && p.user));
  again.plugin.destroy();
});

test('without a user folder, saving a preset reports why', async () => {
  const module = await load();
  const {plugin, page} = open(module);
  const init = openEditor(plugin, page);
  assert.equal(init.userFolder, false);
  page.length = 0;
  plugin.webviewReceive(message({type: 'savePreset', name: 'Nope'}));
  assert.ok(page.some(m => m.type === 'error'));
  plugin.destroy();
});

test('mix groups link instances in one module', async () => {
  const module = await load();
  const a = open(module), b = open(module);
  const init = openEditor(a.plugin, a.page);
  b.plugin.activate(RATE, 1, BLOCK);
  const group = idOf(init, 'mix_group'), drive = idOf(init, 'drive');
  a.plugin.flush([{type: EVENT.PARAM_VALUE, time: 0, id: group, value: 1}]);
  b.plugin.flush([{type: EVENT.PARAM_VALUE, time: 0, id: group, value: 1}]);
  for (let i = 0; i < 3; ++i) { pump(a.plugin); pump(b.plugin); }
  a.plugin.flush([{type: EVENT.PARAM_VALUE, time: 0, id: drive, value: 0.85}]);
  for (let i = 0; i < 3; ++i) { a.plugin.onMainThread(); b.plugin.onMainThread(); }
  assert.ok(Math.abs(b.plugin.paramValue(drive) - 0.85) < 1e-6, `linked drive ${b.plugin.paramValue(drive)}`);
  a.plugin.destroy();
  b.plugin.destroy();
});

test('a latency change asks the host to restart the plug-in', async () => {
  const module = await load();
  const {plugin, page, host} = open(module);
  const init = openEditor(plugin, page);
  const before = plugin.latency();
  plugin.flush([{type: EVENT.PARAM_VALUE, time: 0, id: idOf(init, 'os_factor'), value: 3}]);
  for (let b = 0; b < 4; ++b) { const x = sine(BLOCK, b * BLOCK); plugin.process(BLOCK, {input: [x, x]}); }
  plugin.onMainThread();
  assert.notEqual(plugin.latency(), before);
  assert.ok(host.restarts > 0);
  plugin.destroy();
});

test('the editor gets meters and a scope while it is open and the host processes', async () => {
  const module = await load();
  const {plugin, page} = open(module);
  openEditor(plugin, page);
  page.length = 0;
  for (let b = 0; b < 20; ++b) { const x = sine(BLOCK, b * BLOCK); plugin.process(BLOCK, {input: [x, x]}); pump(plugin); }
  const meters = page.filter(m => m.type === 'meters');
  assert.ok(meters.length >= 3, `${meters.length} meter messages`);
  const last = meters.at(-1);
  assert.ok(Math.abs(20 * Math.log10(last.input[0]) - 20 * Math.log10(0.5 / Math.SQRT2)) < 0.5, `input ${last.input[0]}`);
  assert.equal(last.scope.length, 512);
  plugin.destroy();
});

test('the editor page is a bundled resource, and the module is not', async () => {
  const module = await load();
  const {plugin} = open(module);
  assert.equal(plugin.webviewUri(), '/ui/index.html');
  const page = plugin.webviewResource('/ui/index.html');
  assert.match(page.mime, /^text\/html/);
  assert.match(new TextDecoder().decode(page.data), /window\.CHOWTAPE_TOOLTIPS/);
  assert.equal(plugin.webviewResource('/module.wasm'), null);
  assert.equal(plugin.webviewResource('/ui/../module.wasm'), null);
  plugin.destroy();
});

test('many instances share one module', async () => {
  const module = await load();
  const plugins = Array.from({length: 8}, () => open(module).plugin);
  for (const plugin of plugins) plugin.activate(RATE, 1, BLOCK);
  const x = sine(BLOCK);
  for (let b = 0; b < 4; ++b) for (const plugin of plugins) plugin.process(BLOCK, {input: [x, x]});
  // The desktop DSP's delay lines hold 2^21 samples: about 80 MB per active instance.
  assert.ok(module.memoryBytes() < 8 * 96 * 2 ** 20 + 64 * 2 ** 20, `${module.memoryBytes()} bytes`);
  for (const plugin of plugins) plugin.destroy();
});
