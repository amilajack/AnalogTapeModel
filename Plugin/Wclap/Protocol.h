// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// Messages between the WCLAP plug-in (module.wasm) and its clap.webview/3 page
// (ui/index.html). Each message is one UTF-8 JSON object in an ArrayBuffer, with a
// "type". Parameter ids are the desktop CLAP's (juce::String::hashCode of the
// JUCE parameter id), and values are JUCE's normalized 0..1 values.
//
// Page -> plug-in
//   hello       {}                         The page is ready. The plug-in answers init.
//   param       {id, value}                An edit from the editor: the plug-in applies
//                                          it and gives it to the host as a parameter
//                                          change. It answers params with the new text.
//   paramText   {id, text}                 Set a parameter from text, as a typed value
//                                          (or a tape speed button) in the desktop editor.
//   gesture     {id, begin}                begin (true) or end (false) of a drag.
//   preset      {index}                    Load a preset of the preset list.
//   savePreset  {name}                     Save the state as a user preset (only when
//                                          the host gave the plug-in a user folder).
//   resize      {width, height}            The editor asks the host for a new size.
//
// Plug-in -> page
//   init        {version, plugin, host, params[], presets[], preset, userFolder,
//                status, size}
//               params[i]: {id, key, name, kind ("float" | "bool" | "choice"),
//                           choices[], steps, default, value, text}
//               presets[i]: {index, name, vendor, category, user}
//               preset: {index, name, dirty}
//   params      {values: [[id, value, text], ...]}   Values the page does not show
//                                          yet: host automation, presets, mix groups.
//   preset      {index, name, dirty}       The selected preset or its dirty flag changed.
//   presets     {presets[]}                The preset list changed (a user preset saved).
//   status      {sampleRate, active, processing, latency}
//   meters      {input: [l, r], output: [l, r], scope: []}   RMS levels since the last
//                                          meters, and the latest 512 output samples
//                                          (mono), about 30 times a second while the
//                                          editor is visible and the host processes.
//   size        {width, height}            The host resized the window.
//   error       {message}

namespace ChowTape::Wclap::Protocol
{
constexpr int version = 1;
}
