#!/usr/bin/env python3
"""Create a build-local copy of JUCE's modules with the edits the WCLAP needs.

JUCE 6.1 has partial Wasm support (JUCE_WASM): juce_core builds, but a few
platform switches have no Wasm branch. The pinned submodule is never modified;
every edit is checked against its anchor text, so an incompatible JUCE update
fails here instead of building something different.

usage: prepare_juce.py JUCE_MODULES_DIR OUT_DIR
"""
import filecmp
import pathlib
import shutil
import sys

source, target = map(pathlib.Path, sys.argv[1:])
MODULES = ["juce_core", "juce_events", "juce_data_structures", "juce_audio_basics",
           "juce_audio_formats", "juce_audio_processors", "juce_dsp",
           # Headers only: juce_audio_processors and chowdsp_presets include them.
           "juce_graphics", "juce_gui_basics", "juce_gui_extra", "juce_audio_devices",
           "juce_audio_utils"]
changes = {}


def edit(relative, old, new):
    text = changes.get(relative, (source / relative).read_text())
    if old not in text:
        raise SystemExit(f"JUCE overlay anchor missing: {relative}: {old!r}")
    changes[relative] = text.replace(old, new, 1)


# JUCE 6.1 sets no byte order for Wasm, so ByteOrder treats it as big-endian and
# swaps: binary state (copyXmlToBinary) would not load in the desktop plug-in.
edit("juce_core/system/juce_TargetPlatform.h", '#else\n  #error "Unknown platform!"\n#endif\n',
     '#else\n  #error "Unknown platform!"\n#endif\n\n#if JUCE_WASM\n  #define JUCE_LITTLE_ENDIAN 1\n  #define JUCE_32BIT 1\n#endif\n')
# juce_wasm_SystemStats.cpp uses emscripten_get_now without its header, and JUCE
# has no Wasm File natives (special locations and the like): JuceWasmFiles.cpp.
edit("juce_core/juce_core.cpp", ' #include "native/juce_wasm_SystemStats.cpp"',
     ' #include <emscripten.h>\n #include "native/juce_wasm_SystemStats.cpp"\n #include "JuceWasmFiles.cpp"')
# Only statfs is missing on Wasm; directory iteration needs the stat helpers below it.
edit("juce_core/native/juce_posix_SharedCode.h",
     "        return statfs (f.getFullPathName().toUTF8(), &result) == 0;\n    }\n",
     "        return statfs (f.getFullPathName().toUTF8(), &result) == 0;\n    }\n   #endif\n")
edit("juce_core/native/juce_posix_SharedCode.h",
     "            *isReadOnly = access (path.toUTF8(), W_OK) != 0;\n    }\n   #endif\n",
     "            *isReadOnly = access (path.toUTF8(), W_OK) != 0;\n    }\n")
# Wasm builds with -msse4.1 map SSE intrinsics onto SIMD128, so SIMDRegister can use
# JUCE's SSE native ops.
edit("juce_dsp/juce_dsp.h", " #if defined(__i386__) || defined(__amd64__) || defined(_M_X64) || defined(_X86_) || defined(_M_IX86)",
     " #if defined(__i386__) || defined(__amd64__) || defined(_M_X64) || defined(_X86_) || defined(_M_IX86) || defined(__EMSCRIPTEN__)")
edit("juce_dsp/juce_dsp.cpp", " #if defined(__i386__) || defined(__amd64__) || defined(_M_X64) || defined(_X86_) || defined(_M_IX86)",
     " #if defined(__i386__) || defined(__amd64__) || defined(_M_X64) || defined(_X86_) || defined(_M_IX86) || defined(__EMSCRIPTEN__)")
# Current Clang rejects this (unused) constructor template: AudioProcessor has no
# array constructor to forward to.
edit("juce_audio_processors/processors/juce_AudioPluginInstance.h",
     "    template <size_t numLayouts>\n    AudioPluginInstance (const short channelLayoutList[numLayouts][2]) : AudioProcessor (channelLayoutList) {}\n",
     "")
edit("juce_audio_processors/utilities/juce_PluginHostType.cpp", "   #elif JUCE_ANDROID\n   #else",
     "   #elif JUCE_ANDROID || JUCE_WASM\n   #else")
edit("juce_data_structures/app_properties/juce_PropertiesFile.cpp", "   #elif JUCE_WINDOWS\n    auto dir",
     "   #elif JUCE_WINDOWS || JUCE_WASM\n    auto dir")


def copy_if_changed(src: pathlib.Path, dst: pathlib.Path, text=None):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if text is not None:
        if not dst.exists() or dst.read_text() != text:
            dst.write_text(text)
    elif not dst.exists() or not filecmp.cmp(src, dst, shallow=False):
        shutil.copy2(src, dst)


for module in MODULES:
    for path in (source / module).rglob("*"):
        if path.is_file():
            relative = path.relative_to(source).as_posix()
            copy_if_changed(path, target / relative, changes.get(relative))
