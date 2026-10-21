// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// JUCE's message queue in the WCLAP module (JuceWasm.cpp).

namespace ChowTape::Wclap
{
// Creates the MessageManager on the calling (the module's only) thread.
void startJuce();
// Called whenever JUCE posts a message, from any CLAP call, so the plug-in can ask
// the host for a main-thread callback.
void setMessagePostedCallback (void (*callback)());
bool hasPendingMessages();
// Delivers the messages queued so far. Main thread only.
void dispatchMessages();
} // namespace ChowTape::Wclap
