# CHOWTapeModel as a WCLAP

CHOWTapeModel also builds as a [WCLAP](https://github.com/WebCLAP): a CLAP plug-in
compiled to WebAssembly, with its editor as a `clap.webview/3` page. A host that runs
WCLAPs (a DAW's DSP worker, a browser page, a native bridge such as wasmtime) loads
the bundle:

```
chowtape.wclap/
  module.wasm     the plug-in: ChowtapeModelAudioProcessor behind the CLAP API
  ui/index.html   the editor page (get_uri: /ui/index.html), one self-contained file
  LICENSE, NOTICES.md, SOURCES.md
```

The approach follows the Surge XT WCLAP (`src/surge-wclap` in the Surge fork): a
hand-written CLAP wrapper over the plug-in's own processor, Emscripten standalone
Wasm with WASI imports only, and the same CLAP surface as the desktop plug-in.

## Build

```sh
bash Plugin/Wclap/scripts/build.sh       # build-wclap/wclap/module.wasm
python3 Plugin/Wclap/scripts/package.py  # build-wclap/chowtape.wclap/ and chowtape.wclap.tar.gz
```

`build.sh` installs Emscripten 6.0.10 at a pinned emsdk revision under `.toolchains/`
(the same toolchain as the Surge WCLAP) and configures `Plugin/` with
`-DCHOWTAPE_WCLAP=ON`, which builds only the WCLAP (`Plugin/Wclap/CMakeLists.txt`);
the desktop build is unchanged. CMake 3.21+, Python 3 and Git must be installed.

Objects compile with `-ffile-prefix-map` and link with full LTO, so `module.wasm` is
the same byte for byte whatever the checkout or build directory.

`package.py` inlines the editor's script, styles, fonts and tooltips into
`ui/index.html`, writes a reproducible tarball (sorted entries, fixed owners and
timestamps) and refuses any shipped file that contains a build path.

## How it is built

- **The desktop processor.** `module.wasm` contains `ChowtapeModelAudioProcessor`
  and every DSP source of the desktop plug-in, unchanged but for `CHOWTAPE_WCLAP`
  guards around the JUCE editor (foleys_gui_magic, the scope and light meters, the
  look and feel) and one around the STN model loader, which loads its models in
  turn instead of with `std::async` (the module has no threads).
- **JUCE 6.1 on Wasm.** JUCE's modules are compiled directly, without JUCE's CMake
  API: JUCE 6.1's `juceaide` no longer builds against current macOS SDKs, and the
  module needs a fixed set of sources. `scripts/prepare_juce.py` makes a build-local
  copy of the modules with a few anchor-checked edits (the JUCE submodule is not
  modified):
  - JUCE 6.1 sets no byte order for Wasm, so `ByteOrder` treated it as big-endian
    and swapped. Without the fix, states would not move between the WCLAP and the
    desktop plug-in.
  - `File` natives (special locations, directory iteration) and the SIMD register
    ops (Emscripten maps SSE intrinsics onto Wasm SIMD128, `-msse4.1`), plus a few
    platform switches with no Wasm branch.
  - `JuceWasm.cpp` is JUCE's message queue (AsyncUpdater, `callAsync`): messages
    are delivered from `on_main_thread`, which the plug-in requests when one is
    posted. `JuceWasmFiles.cpp` and `JuceWasmGraphics.cpp` supply the rest
    (`juce::Colour`, which GUI headers' static constants need).
  - `scripts/binary_data.py` writes `BinaryData` with juceaide's resource names.
- **WASI only.** The module imports only `wasi_snapshot_preview1`. File calls
  Emscripten leaves out are answered from the host's preopens (`Wasi.cpp`, from the
  Surge WCLAP). Exceptions are standard Wasm exceptions (`try_table`, which wasmtime
  compiles); the build is full LTO with SIMD128.

## The CLAP surface

The same as the desktop CLAP (clap-juce-extensions as configured in
`Plugin/CMakeLists.txt`), so a project can move between them:

- **Id** `org.chowdsp.CHOWTapeModel`; features `audio-effect`, `distortion`, `stereo`, `mono`.
- **Parameters**: all 52, with the desktop ids (`juce::String::hashCode` of each JUCE
  parameter id), discrete parameters in their JUCE range and the others normalized
  (`CLAP_USE_JUCE_PARAMETER_RANGES DISCRETE`), the parameters' own text, and
  monophonic modulation of the `chowdsp::FloatParameter`s.
- **State**: the desktop `getStateInformation` bytes. Desktop states load in the
  WCLAP and back.
- **Audio ports**: stereo "Input" (32768) and "Output" (1), in-place pairs.
- **Processing**: events apply at a 64-sample resolution, as the desktop CLAP
  (`CLAP_PROCESS_EVENTS_RESOLUTION_SAMPLES 64`). `latency` reports the processor's
  latency; when it changes while active (the oversampling factor), the plug-in asks
  the host to restart it. `render` switches to the offline oversampling settings
  (`os_render_*`), as the desktop plug-in does.
- **Extensions**: `params`, `state`, `audio-ports`, `latency`, `tail`, `render`,
  `gui` (`CLAP_WINDOW_API_WEBVIEW`) and `clap.webview/3`.
- **Instances**: one module instance hosts any number of plug-ins. Mix groups link
  instances in the same module, as they link instances in one desktop process.
  Each active instance takes about 80 MB of linear memory, mostly the desktop DSP's
  2^21-sample delay lines, so a module (4 GB) holds about 45 active instances.

## The editor

`ui/` is an HTML editor laid out like the desktop one (`Source/GUI/Assets/gui.xml`):
the four tabbed panels with their knobs, sliders, buttons and power buttons
(disabled controls when a section is off), the tape speed buttons, the oversampling
menu, the hysteresis mode, the mix group, the preset browser, the tooltips, and a
header with the input and output levels and the output waveform. It scales to the
window from the desktop's 720 x 620.

It is not the JUCE editor: JUCE 6.1 has no browser GUI backend (the Surge WCLAP ports
JUCE 8's GUI to the browser instead). Left out from the desktop editor: the wow and
flutter light meters and tempo sync menus, the mix group visualizer, and the
settings menu's OpenGL and update items.

The page talks to the plug-in only through `clap.webview/3` messages: UTF-8 JSON in
`ArrayBuffer`s (`Protocol.h` lists them). It loads nothing, so it works in a
`sandbox="allow-scripts"` srcdoc frame with no network.

**User presets.** When the host preopens a writable, private folder at the WASI path
`/user`, the plug-in keeps its settings and user presets there
(`/user/Presets/*.chowpreset`, as on the desktop), and the editor's settings menu
can save presets. Without it, the factory presets still load.

## Tests

```sh
cd Plugin/Wclap && pnpm install          # or npm install: @playwright/test
node --test tests/module.test.mjs        # the CLAP surface, audio, state, protocol, presets, mix groups
cmake --build ../../build-wclap --target chowtape-wclap-unit-tests
node tests/unit-tests.mjs                # upstream's headless unit tests, on the Wasm build
npx playwright test                      # the editor in a test host (tests/host)
wasmtime run -W exceptions=y,simd=y --env HOME=/ ../../build-wclap/wclap/unit-tests.wasm
```

The last line runs the same unit tests on wasmtime (checked with wasmtime 50), which
also compiles `module.wasm` with the same flags.

`tests/unit-tests.mjs` runs `Source/Headless/UnitTests` (hysteresis ops, STN model
accuracy, multichannel, mix groups, speed and the level of every factory preset)
compiled to Wasm, under Node's WASI. `tests/host` is a minimal browser host adapted
from the Surge WCLAP test host: `module.wasm` in a dedicated worker that feeds the
plug-in a test signal, audio through an AudioWorklet, and the editor in a sandboxed
srcdoc frame built from `get_resource`. The host code in `host/` (a CLAP host and a
small WASI for Node, workers and worklets) comes from the Surge WCLAP.
