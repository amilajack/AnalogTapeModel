// The JuceHeader.h of the WCLAP build (juce_generate_juce_header writes the desktop
// one). It includes the modules the DSP needs; the editor modules (foleys_gui_magic,
// chowdsp_gui, chowdsp_foleys) are left out, so the sources' JUCE_MODULE_AVAILABLE
// guards compile the plug-in without its JUCE editor.
#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_data_structures/juce_data_structures.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>

#include <chowdsp_core/chowdsp_core.h>
#include <chowdsp_json/chowdsp_json.h>
#include <chowdsp_listeners/chowdsp_listeners.h>
#include <chowdsp_reflection/chowdsp_reflection.h>
#include <chowdsp_serialization/chowdsp_serialization.h>
#include <chowdsp_simd/chowdsp_simd.h>
#include <chowdsp_math/chowdsp_math.h>
#include <chowdsp_dsp_data_structures/chowdsp_dsp_data_structures.h>
#include <chowdsp_filters/chowdsp_filters.h>
#include <chowdsp_dsp_utils/chowdsp_dsp_utils.h>
#include <chowdsp_sources/chowdsp_sources.h>
#include <chowdsp_parameters/chowdsp_parameters.h>
#include <chowdsp_version/chowdsp_version.h>
#include <chowdsp_presets/chowdsp_presets.h>
#include <chowdsp_plugin_base/chowdsp_plugin_base.h>
#include <chowdsp_plugin_utils/chowdsp_plugin_utils.h>

#include "BinaryData.h"

#if ! DONT_SET_USING_JUCE_NAMESPACE
using namespace juce;
#endif

namespace ProjectInfo
{
const char* const projectName = "CHOWTapeModel";
const char* const companyName = "chowdsp";
const char* const versionString = JucePlugin_VersionString;
} // namespace ProjectInfo
