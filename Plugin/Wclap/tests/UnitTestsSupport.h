// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// What the headless unit tests take from juce_audio_plugin_client, which the WCLAP
// build does not compile (juce_CreatePluginFilter.h).
#include <JuceHeader.h>

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();

inline juce::AudioProcessor* createPluginFilterOfType (juce::AudioProcessor::WrapperType type)
{
    juce::AudioProcessor::setTypeOfNextNewPlugin (type);
    auto* processor = createPluginFilter();
    juce::AudioProcessor::setTypeOfNextNewPlugin (juce::AudioProcessor::wrapperType_Undefined);
    return processor;
}
