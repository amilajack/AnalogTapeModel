// SPDX-License-Identifier: GPL-3.0-or-later
// JUCE's message queue for the WCLAP module. JUCE 6.1 has no messaging backend for
// Wasm; this one keeps posted messages (AsyncUpdater, MessageManager::callAsync,
// ChangeBroadcaster) in a queue that the plug-in delivers on the host's main thread
// (Plugin.cpp calls dispatchMessages from on_main_thread and after main-thread calls).
// The module runs on one agent, so the thread that creates the MessageManager is the
// thread of every CLAP call.
#include "JuceWasm.h"
#include <juce_events/juce_events.h>
#include <deque>
#include <pthread.h>
#include <sched.h>

namespace
{
std::deque<juce::MessageManager::MessageBase::Ptr>& queue()
{
    static std::deque<juce::MessageManager::MessageBase::Ptr> messages;
    return messages;
}

void (*postedCallback)() = nullptr;
} // namespace

namespace juce
{
void MessageManager::doPlatformSpecificInitialisation() {}

void MessageManager::doPlatformSpecificShutdown()
{
    queue().clear();
}

bool MessageManager::postMessageToSystemQueue (MessageManager::MessageBase* const message)
{
    queue().emplace_back (message);
    if (postedCallback != nullptr)
        postedCallback();
    return true;
}

void MessageManager::broadcastMessage (const String&) {}

// MessageManager::runDispatchLoop's platform hook. Nothing runs a dispatch loop in
// the module, but JUCE references it.
bool dispatchNextMessageOnSystemQueue (bool)
{
    if (queue().empty())
        return false;

    auto message = queue().front();
    queue().pop_front();
    JUCE_TRY
    {
        message->messageCallback();
    }
    JUCE_CATCH_EXCEPTION
    return true;
}
} // namespace juce

namespace ChowTape::Wclap
{
void startJuce()
{
    juce::MessageManager::getInstance();
}

void setMessagePostedCallback (void (*callback)())
{
    postedCallback = callback;
}

bool hasPendingMessages()
{
    return ! queue().empty();
}

void dispatchMessages()
{
    // Only the messages already queued: a message that posts another (a repeating
    // AsyncUpdater) waits for the next main-thread callback instead of looping here.
    for (auto count = queue().size(); count > 0 && juce::dispatchNextMessageOnSystemQueue (true); --count)
    {
    }
}
} // namespace ChowTape::Wclap

// The module has no threads; JUCE's thread priority calls only need to link.
extern "C"
{
    int sched_get_priority_min (int) { return 0; }
    int sched_get_priority_max (int) { return 0; }
    int pthread_setschedparam (pthread_t, int, const struct sched_param*) { return ENOSYS; }
}
