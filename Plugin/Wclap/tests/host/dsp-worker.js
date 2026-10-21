// SPDX-License-Identifier: GPL-3.0-or-later
// The DSP agent of the WCLAP test host: one module.wasm instance, its plug-in, and
// every CLAP call (audio and main-thread calls alike), as a DAW's DSP worker. The
// bundle's files reach WASI through synchronous requests; the plug-in's private
// user folder (/user) is kept in memory for as long as the host runs.
// Adapted from the Surge XT WCLAP test host; the plug-in is an effect, so the worker
// renders a test signal into its input.
import {WclapModule, EVENT} from '../../host/clap-host.mjs';
import {httpFiles, memoryFiles} from '../../host/wasi.mjs';

let module = null, plugin = null, audioPort = null, windowOpen = false, user = null;
let source = 'sine', phase = 0, seed = 1;
const pending = [];
const stats = {blocks: 0, peak: 0, outEvents: []};
const post = (message, transfer = []) => self.postMessage(message, transfer);

const callbacks = {
  requestCallback() { setTimeout(() => plugin?.onMainThread(), 0); },
  requestProcess() { post({type: 'event', name: 'requestProcess'}); },
  requestRestart() { post({type: 'event', name: 'requestRestart'}); },
  requestFlush() { setTimeout(() => { if (plugin && !plugin.processing) record(plugin.flush([])); }, 0); },
  paramsRescan(flags) { post({type: 'event', name: 'rescan', flags}); },
  markDirty() { post({type: 'event', name: 'dirty'}); },
  requestResize(width, height) { post({type: 'event', name: 'resize', width, height}); return true; },
  webviewSend(buffer) {
    if (!windowOpen) return false;
    post({type: 'webview', buffer}, [buffer]);
    return true;
  },
  log(severity, text) { post({type: 'event', name: 'log', severity, text}); },
};

function record(events) {
  stats.outEvents.push(...events);
  if (stats.outEvents.length > 4096) stats.outEvents.splice(0, stats.outEvents.length - 4096);
}

function input(frames) {
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; ++i) {
    let x = 0;
    if (source === 'sine') { x = 0.5 * Math.sin(phase); phase += 2 * Math.PI * 220 / 48000; }
    else if (source === 'noise') { seed = (seed * 1664525 + 1013904223) >>> 0; x = 0.25 * (seed / 2 ** 31 - 1); }
    left[i] = right[i] = x;
  }
  return [left, right];
}

function render(frames) {
  const events = pending.splice(0).map(event => ({...event, time: 0}));
  const result = plugin.process(frames, {events, input: input(frames)});
  record(result.events);
  stats.blocks++;
  let peak = 0;
  for (let i = 0; i < frames; ++i) peak = Math.max(peak, Math.abs(result.left[i]), Math.abs(result.right[i]));
  stats.peak = Math.max(stats.peak * 0.97, peak);
  return [result.left.slice(), result.right.slice()];
}

const methods = {
  async load({bundle, seed}) {
    const bytes = await (await fetch(new URL('module.wasm', bundle))).arrayBuffer();
    user ??= memoryFiles();
    module = await WclapModule.load({bytes, files: httpFiles(new URL('.', bundle).href), user, seed});
    return module.descriptors();
  },
  create({id, rate}) {
    plugin = module.createPlugin(id, callbacks);
    plugin.activate(rate, 32, 4096);
    return {latency: plugin.latency(), tail: plugin.tail(), audioInputs: plugin.audioPorts(true),
      audioOutputs: plugin.audioPorts(false), params: plugin.paramCount()};
  },
  audio(_, port) {
    audioPort = port;
    audioPort.onmessage = ({data}) => {
      const [left, right] = render(data.frames);
      audioPort.postMessage({left, right}, [left.buffer, right.buffer]);
    };
  },
  source({kind}) { source = kind; },
  automate({id, value}) { pending.push({type: EVENT.PARAM_VALUE, id, value}); },
  param({id}) { const value = plugin.paramValue(id); return {value, text: plugin.paramText(id, value)}; },
  paramByName({name}) {
    for (let i = 0, n = plugin.paramCount(); i < n; ++i) {
      const info = plugin.paramInfo(i);
      if (info.name === name) return {...info, value: plugin.paramValue(info.id), text: plugin.paramText(info.id, plugin.paramValue(info.id))};
    }
    return null;
  },
  stats() { return {blocks: stats.blocks, peak: stats.peak, outEvents: stats.outEvents.splice(0)}; },
  guiSetSize({width, height}) { const adjusted = plugin.guiAdjustSize(width, height); return {ok: plugin.guiSetSize(adjusted.width, adjusted.height), ...adjusted}; },
  guiShow() { return plugin.guiShow(); },
  guiHide() { return plugin.guiHide(); },
  userFiles() { return [...user.entries].map(([path, entry]) => ({path, type: entry.type, size: entry.data?.length ?? 0})); },
  userFile({path}) { return user.read(path); },
  saveState() { return plugin.saveState(); },
  loadState({bytes}) { return plugin.loadState(bytes); },
  guiCreate() { const ok = plugin.guiCreate(); return {ok, size: plugin.guiSize(), uri: plugin.webviewUri()}; },
  guiDestroy() { windowOpen = false; plugin.guiDestroy(); },
  resource({path}) {
    const found = plugin.webviewResource(path);
    return found && {mime: found.mime, data: found.data};
  },
  open() { windowOpen = true; },
  receive({buffer}) { return plugin.webviewReceive(new Uint8Array(buffer)); },
};

self.onmessage = async ({data, ports}) => {
  const {id, method, args} = data;
  try {
    const result = await methods[method](args ?? {}, ports[0]);
    const transfer = result?.data instanceof Uint8Array ? [result.data.buffer]
      : result instanceof Uint8Array ? [result.buffer] : [];
    if (id !== undefined) post({type: 'reply', id, result}, transfer);
  } catch (error) {
    if (id !== undefined) post({type: 'reply', id, error: String(error && error.stack || error)});
  }
};
