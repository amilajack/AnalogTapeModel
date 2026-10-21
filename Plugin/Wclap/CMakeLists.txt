# CHOWTapeModel as a WCLAP: the CLAP plug-in compiled to standalone Wasm
# (module.wasm), with its editor as a clap.webview/3 page (ui/).
# Configure with emcmake and -DCHOWTAPE_WCLAP=ON (Wclap/scripts/build.sh).
#
# The module is the desktop plug-in's processor (ChowtapeModelAudioProcessor, the
# same DSP, parameters, presets and state) built on JUCE's headless modules. JUCE's
# CMake API is not used: JUCE 6.1's juceaide does not build against current macOS
# SDKs, and the module needs only a fixed set of module sources.
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "CHOWTAPE_WCLAP needs Emscripten: configure with emcmake (Wclap/scripts/build.sh)")
endif()

set(CLAP_INCLUDE ${CMAKE_SOURCE_DIR}/modules/clap/include)
file(STRINGS ${CLAP_INCLUDE}/clap/version.h clap_version REGEX "#define CLAP_VERSION_(MAJOR|MINOR|REVISION) ")
if(NOT clap_version MATCHES "MAJOR 1.*MINOR 2.*REVISION 7")
    message(FATAL_ERROR "The WCLAP is pinned to CLAP 1.2.7 (clap.webview/3); review the API before updating")
endif()

# A WCLAP owns non-shared memory and every CLAP call arrives on one host agent: no
# pthreads, no JavaScript runtime, and standard Wasm exceptions (try_table/throw_ref,
# which wasmtime compiles, rather than the legacy try/catch/rethrow).
# -msse4.1: xsimd 9 and JUCE's SIMD code have no Wasm backend; Emscripten maps their
# SSE intrinsics onto Wasm SIMD128.
add_compile_options(-msimd128 -msse4.1 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0
    -Wno-deprecated-declarations -Wno-unused-command-line-argument)
add_link_options(-msimd128 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0)
# Full LTO: one merged module whatever the build directory (ThinLTO names promoted
# symbols after object paths), and the JUCE editor code the processor never reaches
# is dropped. Link-time code generation needs Wasm exception handling enabled in the
# backend too, or LLVM drops every landing pad and a C++ throw traps.
add_compile_options(-flto=full)
add_link_options(-flto=full "SHELL:-Wl,-mllvm,-wasm-enable-eh" "SHELL:-Wl,-mllvm,-exception-model=wasm")
# Reproducible artifacts: no checkout, build or toolchain paths in the output.
get_filename_component(emscripten_root "${CMAKE_C_COMPILER}" DIRECTORY)
add_compile_options("-ffile-prefix-map=${CMAKE_SOURCE_DIR}/..=chowtape"
    "-ffile-prefix-map=${CMAKE_BINARY_DIR}=build"
    "-ffile-prefix-map=${emscripten_root}=emscripten")

find_package(Python3 REQUIRED COMPONENTS Interpreter)
# A build-local copy of JUCE's modules with the Wasm edits of scripts/prepare_juce.py;
# the JUCE submodule is not modified.
set(JUCE_MODULES ${CMAKE_CURRENT_BINARY_DIR}/juce-wasm)
execute_process(COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/scripts/prepare_juce.py
        ${CMAKE_SOURCE_DIR}/modules/JUCE/modules ${JUCE_MODULES}
    RESULT_VARIABLE juce_overlay_result)
if(NOT juce_overlay_result EQUAL 0)
    message(FATAL_ERROR "Unable to prepare the JUCE modules for Wasm")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/scripts/prepare_juce.py)
set(CHOWDSP_MODULES ${CMAKE_SOURCE_DIR}/modules/chowdsp_utils/modules)
set(SOURCE ${CMAKE_SOURCE_DIR}/Source)

# BinaryData: the same resources, in the same order, as Source/CMakeLists.txt.
file(GLOB UI_ASSET_FILES ${SOURCE}/GUI/Assets/*)
file(GLOB_RECURSE PRESET_FILES ${SOURCE}/Presets/PresetConfigs/*.chowpreset)
file(GLOB STN_MODEL_FILES ${SOURCE}/Processors/Hysteresis/STN_Models/*.json)
set(binary_data_files ${UI_ASSET_FILES} ${PRESET_FILES} ${STN_MODEL_FILES})
set(generated ${CMAKE_CURRENT_BINARY_DIR}/generated)
add_custom_command(OUTPUT ${generated}/BinaryData.h ${generated}/BinaryData.cpp
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/scripts/binary_data.py ${generated} ${binary_data_files}
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/scripts/binary_data.py ${binary_data_files}
    VERBATIM)

set(juce_modules juce_core juce_events juce_data_structures juce_audio_basics
    juce_audio_formats juce_audio_processors juce_dsp)
set(chowdsp_modules
    common/chowdsp_core common/chowdsp_json common/chowdsp_listeners common/chowdsp_reflection
    common/chowdsp_serialization
    dsp/chowdsp_simd dsp/chowdsp_math dsp/chowdsp_dsp_data_structures dsp/chowdsp_filters
    dsp/chowdsp_dsp_utils dsp/chowdsp_sources
    plugin/chowdsp_parameters plugin/chowdsp_version plugin/chowdsp_presets
    plugin/chowdsp_plugin_base plugin/chowdsp_plugin_utils)

set(module_sources)
set(module_defines)
foreach(module ${juce_modules})
    list(APPEND module_sources ${JUCE_MODULES}/${module}/${module}.cpp)
    list(APPEND module_defines JUCE_MODULE_AVAILABLE_${module}=1)
endforeach()
set(chowdsp_include_dirs)
foreach(module ${chowdsp_modules})
    get_filename_component(name ${module} NAME)
    get_filename_component(group ${module} DIRECTORY)
    if(EXISTS ${CHOWDSP_MODULES}/${module}/${name}.cpp)
        list(APPEND module_sources ${CHOWDSP_MODULES}/${module}/${name}.cpp)
    endif()
    list(APPEND module_defines JUCE_MODULE_AVAILABLE_${name}=1)
    list(APPEND chowdsp_include_dirs ${CHOWDSP_MODULES}/${group})
endforeach()
list(REMOVE_DUPLICATES chowdsp_include_dirs)

# RTNeural with its xsimd backend, as the desktop build (modules/CMakeLists.txt).
# Its one source is compiled here: its CMake project predates CMake 3.5.
set(RTNEURAL ${CMAKE_SOURCE_DIR}/modules/RTNeural)

# The plug-in's processor and the modules it needs, shared by the module and the
# unit tests.
add_library(chowtape-wclap-dsp OBJECT
    JuceWasm.cpp
    JuceWasmGraphics.cpp
    Wasi.cpp
    ${generated}/BinaryData.cpp
    ${module_sources}
    ${RTNEURAL}/RTNeural/RTNeural.cpp

    ${SOURCE}/PluginProcessor.cpp
    ${SOURCE}/MixGroups/MixGroupsController.cpp
    ${SOURCE}/MixGroups/MixGroupsSharedData.cpp
    ${SOURCE}/Presets/PresetManager.cpp
    ${SOURCE}/Processors/Chew/ChewProcessor.cpp
    ${SOURCE}/Processors/Compression/CompressionProcessor.cpp
    ${SOURCE}/Processors/Degrade/DegradeProcessor.cpp
    ${SOURCE}/Processors/Hysteresis/HysteresisProcessing.cpp
    ${SOURCE}/Processors/Hysteresis/HysteresisProcessor.cpp
    ${SOURCE}/Processors/Hysteresis/HysteresisSTN.cpp
    ${SOURCE}/Processors/Hysteresis/STNModel.cpp
    ${SOURCE}/Processors/Hysteresis/ToneControl.cpp
    ${SOURCE}/Processors/Input_Filters/InputFilters.cpp
    ${SOURCE}/Processors/Loss_Effects/AzimuthProc.cpp
    ${SOURCE}/Processors/Loss_Effects/LossFilter.cpp
    ${SOURCE}/Processors/MidSide/MidSideProcessor.cpp
    ${SOURCE}/Processors/Timing_Effects/WowFlutterProcessor.cpp
    ${SOURCE}/Processors/Timing_Effects/FlutterProcess.cpp
    ${SOURCE}/Processors/Timing_Effects/WowProcess.cpp)

target_include_directories(chowtape-wclap-dsp PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${generated}
    ${SOURCE}
    ${JUCE_MODULES}
    ${chowdsp_include_dirs}
    ${RTNEURAL}
    ${RTNEURAL}/modules/json
    ${RTNEURAL}/modules/xsimd/include
    ${CLAP_INCLUDE})

target_compile_definitions(chowtape-wclap-dsp PUBLIC
    ${module_defines}
    CHOWTAPE_WCLAP=1
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
    JUCE_STANDALONE_APPLICATION=0
    JucePlugin_Build_Standalone=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_REPORT_APP_USAGE=0
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    # As the desktop build (modules/CMakeLists.txt); the unit tests run dispatch loops.
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_PLUGINHOST_VST=0
    JUCE_PLUGINHOST_VST3=0
    JUCE_PLUGINHOST_AU=0
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_PLUGINHOST_LV2=0
    JUCE_USE_FLAC=0
    JUCE_USE_OGGVORBIS=0
    JUCE_USE_MP3AUDIOFORMAT=0
    JUCE_USE_LAME_AUDIO_FORMAT=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=0
    JUCE_CHECK_MEMORY_LEAKS=0
    JUCE_DONT_DECLARE_PROJECTINFO=1
    CHOWDSP_AUTO_UPDATE=0
    USE_XSIMD=1
    RTNEURAL_USE_XSIMD=1
    JucePlugin_Manufacturer="chowdsp"
    JucePlugin_VersionString="${CMAKE_PROJECT_VERSION}"
    JucePlugin_Name="${CMAKE_PROJECT_NAME}"
    JucePlugin_IsSynth=0
    JucePlugin_WantsMidiInput=0
    JucePlugin_ProducesMidiOutput=0
    JucePlugin_IsMidiEffect=0
    NDEBUG=1)
target_compile_options(chowtape-wclap-dsp PUBLIC -O3 -Wno-everything)

set(wasm_link_options
    -O3
    -sSTANDALONE_WASM=1 -sPURE_WASI=1
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=4294967296
    -sSTACK_SIZE=1048576
    # A name section, so profilers attribute time to functions.
    --profiling-funcs)

# The plug-in: a WASI reactor that exports clap_entry.
add_executable(chowtape-wclap Entry.cpp Plugin.cpp)
target_link_libraries(chowtape-wclap PRIVATE chowtape-wclap-dsp)
set_target_properties(chowtape-wclap PROPERTIES
    OUTPUT_NAME module SUFFIX .wasm
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/wclap)
target_link_options(chowtape-wclap PRIVATE
    ${wasm_link_options}
    --no-entry -sALLOW_TABLE_GROWTH=1
    -sEXPORTED_FUNCTIONS=['_malloc','_free']
    -Wl,--export=clap_entry
    -Wl,--export-table)

# Upstream's headless unit tests (Source/Headless/UnitTests) on the Wasm build, as a
# WASI command: node tests/unit-tests.mjs runs it.
add_executable(chowtape-wclap-unit-tests EXCLUDE_FROM_ALL
    tests/UnitTestsMain.cpp
    ${SOURCE}/Headless/UnitTests/HysteresisOpsTest.cpp
    ${SOURCE}/Headless/UnitTests/MixGroupsTest.cpp
    ${SOURCE}/Headless/UnitTests/MultiChannelTest.cpp
    ${SOURCE}/Headless/UnitTests/SpeedTest.cpp
    ${SOURCE}/Headless/UnitTests/STNTest.cpp
    ${SOURCE}/Headless/UnitTests/PresetLevelTest.cpp)
target_link_libraries(chowtape-wclap-unit-tests PRIVATE chowtape-wclap-dsp)
# The tests call juce_audio_plugin_client's createPluginFilterOfType.
target_compile_options(chowtape-wclap-unit-tests PRIVATE -include ${CMAKE_CURRENT_SOURCE_DIR}/tests/UnitTestsSupport.h)
set_target_properties(chowtape-wclap-unit-tests PROPERTIES
    OUTPUT_NAME unit-tests SUFFIX .wasm
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/wclap)
target_link_options(chowtape-wclap-unit-tests PRIVATE ${wasm_link_options})
