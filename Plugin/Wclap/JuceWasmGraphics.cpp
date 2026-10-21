// SPDX-License-Identifier: GPL-3.0-or-later
// juce::Colour for the WCLAP module. JUCE's GUI headers, which juce_audio_processors
// includes, define colour constants that run Colour's constructor at start-up, so
// the module links Colour's implementation without the rest of juce_graphics.
#include <juce_graphics/juce_graphics.h>
#include "juce_graphics/colour/juce_Colour.cpp"
