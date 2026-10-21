// SPDX-License-Identifier: GPL-3.0-or-later
// CHOWTapeModel as a WCLAP plug-in: the desktop processor (ChowtapeModelAudioProcessor)
// behind the CLAP API, with the editor as a clap.webview/3 page (ui/index.html).
//
// The CLAP surface follows the desktop CLAP (clap-juce-extensions, as configured in
// Plugin/CMakeLists.txt) so a project can move between the two: the same plug-in id,
// parameter ids (juce::String::hashCode of each JUCE parameter id), ranges (discrete
// parameters in their JUCE range, the others normalized), state bytes
// (getStateInformation), audio ports and port ids, and events applied at a
// 64-sample resolution.
//
// Threading: the module has its own, non-shared memory, so a host calls every
// function of every instance on the one agent that owns the module. Main-thread and
// audio-thread calls never overlap. JUCE's message queue (JuceWasm.cpp) is delivered
// from on_main_thread.
#include "Plugin.h"
#include "JuceWasm.h"
#include "Protocol.h"
#include "Wasi.h"
#include "PluginProcessor.h"
#include <clap/ext/draft/webview.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <memory>
#include <unordered_map>
#include <vector>

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();

namespace ChowTape::Wclap
{
namespace
{
    // CLAP_PROCESS_EVENTS_RESOLUTION_SAMPLES of the desktop CLAP.
    constexpr uint32_t eventResolution = 64;
    // The editor's size in CSS pixels: the desktop editor's default (gui.xml).
    constexpr uint32_t defaultWidth = 720, defaultHeight = 620;
    constexpr uint32_t minimumWidth = 420, minimumHeight = 360;
    constexpr uint32_t inputPortId = 1u << 15, outputPortId = 1;
    // The editor's scope: the latest output samples (mono), as the desktop TapeScope.
    constexpr size_t scopeSize = 512;

    const char* mimeFor (const std::string& path)
    {
        const auto dot = path.find_last_of ('.');
        const auto extension = dot == std::string::npos ? std::string() : path.substr (dot + 1);
        if (extension == "html")
            return "text/html; charset=utf-8";
        if (extension == "js" || extension == "mjs")
            return "text/javascript; charset=utf-8";
        if (extension == "css")
            return "text/css; charset=utf-8";
        if (extension == "json")
            return "application/json";
        if (extension == "svg")
            return "image/svg+xml";
        if (extension == "png")
            return "image/png";
        if (extension == "ttf")
            return "font/ttf";
        if (extension == "woff2")
            return "font/woff2";
        if (extension == "txt" || extension == "md")
            return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    // A resource path below the bundle: absolute, with no "." or ".." segments.
    bool safeResourcePath (const char* path)
    {
        if (! path || path[0] != '/' || std::strlen (path) > 1024)
            return false;
        const std::string text (path);
        size_t start = 1;
        while (start <= text.size())
        {
            auto end = text.find ('/', start);
            if (end == std::string::npos)
                end = text.size();
            const auto part = text.substr (start, end - start);
            if (part.empty() || part == "." || part == ".." || part.find ('\\') != std::string::npos)
                return false;
            start = end + 1;
        }
        return true;
    }

    struct ParamEntry
    {
        juce::AudioProcessorParameter* param = nullptr;
        juce::RangedAudioParameter* ranged = nullptr;
        chowdsp::ParamUtils::ModParameterMixin* modulation = nullptr;
        clap_id id = CLAP_INVALID_ID;
        juce::String key;
        bool discrete = false; // CLAP values in the JUCE range (CLAP_USE_JUCE_PARAMETER_RANGES DISCRETE)

        double toClap (float normalised) const
        {
            return discrete ? (double) ranged->convertFrom0to1 (normalised) : (double) normalised;
        }
        float toNormalised (double value) const
        {
            const auto v = discrete ? ranged->convertTo0to1 ((float) value) : (float) value;
            return juce::jlimit (0.0f, 1.0f, v);
        }
    };

    struct Outgoing
    {
        uint16_t type; // CLAP_EVENT_PARAM_VALUE or a gesture
        clap_id id;
        double value;
    };

    class ChowTapeWclap;
    std::vector<ChowTapeWclap*>& liveInstances()
    {
        static std::vector<ChowTapeWclap*> list;
        return list;
    }

    juce::String toJson (juce::DynamicObject* object)
    {
        return juce::JSON::toString (juce::var (object), true);
    }

    class ChowTapeWclap final : private juce::AudioProcessorListener,
                                private juce::AudioPlayHead,
                                private chowdsp::PresetManager::Listener
    {
    public:
        explicit ChowTapeWclap (const clap_host_t* h) : host (h)
        {
            plugin.desc = &descriptor;
            plugin.plugin_data = this;
            plugin.init = [] (const clap_plugin_t* p) { return self (p)->init(); };
            plugin.destroy = [] (const clap_plugin_t* p) { delete self (p); };
            plugin.activate = [] (const clap_plugin_t* p, double rate, uint32_t, uint32_t maxFrames)
            { return self (p)->activate (rate, maxFrames); };
            plugin.deactivate = [] (const clap_plugin_t* p) { self (p)->deactivate(); };
            plugin.start_processing = [] (const clap_plugin_t* p)
            {
                self (p)->setProcessing (true);
                return true;
            };
            plugin.stop_processing = [] (const clap_plugin_t* p) { self (p)->setProcessing (false); };
            plugin.reset = [] (const clap_plugin_t* p) { self (p)->reset(); };
            plugin.process = [] (const clap_plugin_t* p, const clap_process_t* process)
            {
                try
                {
                    return self (p)->process (process);
                }
                catch (...)
                {
                    return clap_process_status (CLAP_PROCESS_ERROR);
                }
            };
            plugin.get_extension = [] (const clap_plugin_t* p, const char* id) { return extension (id); };
            plugin.on_main_thread = [] (const clap_plugin_t* p) { self (p)->onMainThread(); };
            liveInstances().push_back (this);
        }

        ~ChowTapeWclap() override
        {
            auto& list = liveInstances();
            list.erase (std::remove (list.begin(), list.end(), this), list.end());
            if (processor)
            {
                processor->getPresetManager().removeListener (this);
                processor->removeListener (this);
                processor->setPlayHead (nullptr);
                if (activated)
                    processor->releaseResources();
                processor.reset();
            }
            // Messages the processor posted while it was being destroyed.
            dispatchMessages();
        }

        clap_plugin_t plugin {};

    private:
        const clap_host_t* host;
        const clap_host_params_t* hostParams {};
        const clap_host_latency_t* hostLatency {};
        const clap_host_gui_t* hostGui {};
        const clap_host_webview_t* hostWebview {};
        const clap_host_log_t* hostLog {};

        std::unique_ptr<ChowtapeModelAudioProcessor> processor;
        std::vector<ParamEntry> params;
        std::unordered_map<clap_id, size_t> paramIndex;

        bool activated = false, processing = false;
        double sampleRate = 48000.0;
        uint32_t maxFrames = 0;
        std::vector<float> scratch[2];

        // Host transport, for the processor's AudioPlayHead.
        juce::AudioPlayHead::CurrentPositionInfo position;

        // Parameter changes for the host (editor edits, presets, mix groups).
        std::vector<Outgoing> outgoing;
        bool suppressHostEcho = false; // set while applying the host's own changes

        bool callbackRequested = false;
        bool latencyChanged = false, statusChanged = false, presetChanged = false, presetListChanged = false;
        uint32_t reportedLatency = 0;

        // Webview state. The page is open from its hello until the GUI is destroyed or a
        // send fails.
        bool guiCreated = false, guiVisible = true, pageOpen = false;
        uint32_t width = defaultWidth, height = defaultHeight;
        std::vector<float> pageValues; // what the page shows, by parameter index
        uint32_t framesSinceMeters = 0;
        bool metersDue = false;
        double squaresIn[2] {}, squaresOut[2] {};
        uint32_t meterFrames = 0;
        std::vector<float> scope = std::vector<float> (scopeSize, 0.0f);
        size_t scopeAt = 0;

        static ChowTapeWclap* self (const clap_plugin_t* p) { return static_cast<ChowTapeWclap*> (p->plugin_data); }

        void log (clap_log_severity severity, const juce::String& message)
        {
            if (hostLog)
                hostLog->log (host, severity, message.toRawUTF8());
        }

        template <typename F>
        bool guarded (const char* what, F&& fn)
        {
            try
            {
                fn();
                return true;
            }
            catch (const std::exception& error)
            {
                log (CLAP_LOG_ERROR, juce::String (what) + ": " + error.what());
            }
            catch (...)
            {
                log (CLAP_LOG_ERROR, what);
            }
            return false;
        }

        // ---- lifecycle -------------------------------------------------------
        bool init()
        {
            hostParams = static_cast<const clap_host_params_t*> (host->get_extension (host, CLAP_EXT_PARAMS));
            hostLatency = static_cast<const clap_host_latency_t*> (host->get_extension (host, CLAP_EXT_LATENCY));
            hostGui = static_cast<const clap_host_gui_t*> (host->get_extension (host, CLAP_EXT_GUI));
            hostWebview = static_cast<const clap_host_webview_t*> (host->get_extension (host, CLAP_EXT_WEBVIEW));
            hostLog = static_cast<const clap_host_log_t*> (host->get_extension (host, CLAP_EXT_LOG));

            return guarded ("CHOWTapeModel failed to start", [&]
                            {
                startJuce();
                setMessagePostedCallback (&messagePosted);
                // ChowTape keeps its settings and user presets below the user's
                // application data folder: the host's private /user folder when it gives
                // one (JuceWasmFiles.cpp).
                const bool userFolder = Wasi::hasPreopen ("/user");
                if (userFolder)
                    setenv ("HOME", "/user", 1);

                juce::PluginHostType::jucePlugInClientCurrentWrapperType = juce::AudioProcessor::wrapperType_Undefined;
                processor.reset (static_cast<ChowtapeModelAudioProcessor*> (createPluginFilter()));
                if (! processor)
                    throw std::runtime_error ("The processor was not created");
                processor->setPlayHead (this);
                processor->setPlayConfigDetails (2, 2, sampleRate, 512);
                buildParameterTable();
                processor->addListener (this);

                auto& presets = processor->getPresetManager();
                presets.addListener (this);
                if (userFolder && presets.getUserPresetPath() == juce::File())
                {
                    const juce::File folder ("/user/Presets");
                    folder.createDirectory();
                    presets.setUserPresetPath (folder);
                }
                reportedLatency = (uint32_t) std::max (0, processor->getLatencySamples());
                dispatchMessages(); });
        }

        void buildParameterTable()
        {
            const auto& all = processor->getParameters();
            params.reserve ((size_t) all.size());
            for (auto* param : all)
            {
                ParamEntry entry;
                entry.param = param;
                entry.ranged = dynamic_cast<juce::RangedAudioParameter*> (param);
                entry.modulation = dynamic_cast<chowdsp::ParamUtils::ModParameterMixin*> (param);
                if (auto* withId = dynamic_cast<juce::AudioProcessorParameterWithID*> (param))
                    entry.key = withId->paramID;
                else
                    entry.key = juce::String (param->getParameterIndex());
                // clap-juce-extensions' generateClapIDForJuceParam.
                entry.id = (clap_id) (uint32_t) entry.key.hashCode();
                entry.discrete = entry.ranged != nullptr && param->isDiscrete();
                paramIndex[entry.id] = params.size();
                params.push_back (entry);
            }
        }

        bool activate (double rate, uint32_t frames)
        {
            if (! processor || ! std::isfinite (rate) || rate < 8000 || rate > 768000 || frames == 0)
                return false;
            const bool ok = guarded ("CHOWTapeModel could not activate", [&]
                                     {
                sampleRate = rate;
                maxFrames = frames;
                for (auto& s : scratch)
                    s.assign (frames, 0.0f);
                processor->setPlayConfigDetails (2, 2, rate, (int) frames);
                processor->prepareToPlay (rate, (int) frames);
                dispatchMessages(); });
            activated = ok;
            statusChanged = true;
            if (ok)
                checkLatency();
            if (pageOpen)
                sendStatus();
            return ok;
        }

        void deactivate()
        {
            if (activated)
                guarded ("CHOWTapeModel could not deactivate", [&] { processor->releaseResources(); });
            activated = false;
            processing = false;
            if (pageOpen)
                sendStatus();
        }

        // Audio thread: the editor hears about it from the main thread.
        void setProcessing (bool on)
        {
            processing = on;
            statusChanged = true;
            requestCallback();
        }

        void reset()
        {
            guarded ("CHOWTapeModel could not reset", [&] { processor->reset(); });
        }

        void requestCallback()
        {
            if (! callbackRequested)
            {
                callbackRequested = true;
                host->request_callback (host);
            }
        }

        static void messagePosted()
        {
            // JUCE messages are module-wide; any live instance's main-thread callback
            // delivers them.
            if (! liveInstances().empty())
                liveInstances().front()->requestCallback();
        }

        void onMainThread()
        {
            callbackRequested = false;
            dispatchMessages();
            if (latencyChanged)
            {
                latencyChanged = false;
                checkLatency();
            }
            if (! pageOpen)
                return;
            if (statusChanged)
            {
                statusChanged = false;
                sendStatus();
            }
            if (presetListChanged)
            {
                presetListChanged = false;
                sendPresetList();
            }
            if (presetChanged)
            {
                presetChanged = false;
                sendPreset();
            }
            sendParamChanges();
            if (metersDue)
            {
                metersDue = false;
                sendMeters();
            }
        }

        void checkLatency()
        {
            const auto latency = (uint32_t) std::max (0, processor->getLatencySamples());
            if (latency == reportedLatency)
                return;
            reportedLatency = latency;
            // CLAP: latency may only change while deactivated; an active plug-in asks
            // the host to restart it.
            if (activated)
                host->request_restart (host);
            else if (hostLatency)
                hostLatency->changed (host);
            statusChanged = true;
        }

        // ---- juce::AudioProcessorListener ------------------------------------
        void audioProcessorParameterChanged (juce::AudioProcessor*, int index, float newValue) override
        {
            if (suppressHostEcho || index < 0 || (size_t) index >= params.size())
                return;
            const auto& entry = params[(size_t) index];
            outgoing.push_back ({ CLAP_EVENT_PARAM_VALUE, entry.id, entry.toClap (newValue) });
            if (hostParams)
                hostParams->request_flush (host);
        }

        void audioProcessorParameterChangeGestureBegin (juce::AudioProcessor*, int index) override
        {
            if (index >= 0 && (size_t) index < params.size())
                queueGesture (CLAP_EVENT_PARAM_GESTURE_BEGIN, params[(size_t) index]);
        }

        void audioProcessorParameterChangeGestureEnd (juce::AudioProcessor*, int index) override
        {
            if (index >= 0 && (size_t) index < params.size())
                queueGesture (CLAP_EVENT_PARAM_GESTURE_END, params[(size_t) index]);
        }

        void queueGesture (uint16_t type, const ParamEntry& entry)
        {
            outgoing.push_back ({ type, entry.id, 0.0 });
            if (hostParams)
                hostParams->request_flush (host);
        }

        void audioProcessorChanged (juce::AudioProcessor*, const ChangeDetails& details) override
        {
            if (details.latencyChanged)
            {
                latencyChanged = true;
                requestCallback();
            }
        }

        // ---- chowdsp::PresetManager::Listener ---------------------------------
        void presetListUpdated() override
        {
            presetListChanged = true;
            requestCallback();
        }
        void presetDirtyStatusChanged() override
        {
            presetChanged = true;
            requestCallback();
        }
        void selectedPresetChanged() override
        {
            presetChanged = true;
            requestCallback();
        }

        // ---- juce::AudioPlayHead ---------------------------------------------
        bool getCurrentPosition (CurrentPositionInfo& result) override
        {
            result = position;
            return true;
        }

        void updateTransport (const clap_event_transport_t* transport)
        {
            if (! transport)
                return;
            auto& p = position;
            if (transport->flags & CLAP_TRANSPORT_HAS_TEMPO)
                p.bpm = transport->tempo;
            if (transport->flags & CLAP_TRANSPORT_HAS_TIME_SIGNATURE)
            {
                p.timeSigNumerator = transport->tsig_num;
                p.timeSigDenominator = transport->tsig_denom;
            }
            if (transport->flags & CLAP_TRANSPORT_HAS_BEATS_TIMELINE)
            {
                p.ppqPosition = (double) transport->song_pos_beats / (double) CLAP_BEATTIME_FACTOR;
                p.ppqPositionOfLastBarStart = (double) transport->bar_start / (double) CLAP_BEATTIME_FACTOR;
                p.ppqLoopStart = (double) transport->loop_start_beats / (double) CLAP_BEATTIME_FACTOR;
                p.ppqLoopEnd = (double) transport->loop_end_beats / (double) CLAP_BEATTIME_FACTOR;
            }
            if (transport->flags & CLAP_TRANSPORT_HAS_SECONDS_TIMELINE)
            {
                p.timeInSeconds = (double) transport->song_pos_seconds / (double) CLAP_SECTIME_FACTOR;
                p.timeInSamples = (juce::int64) (p.timeInSeconds * sampleRate);
            }
            p.isPlaying = (transport->flags & CLAP_TRANSPORT_IS_PLAYING) != 0;
            p.isRecording = (transport->flags & CLAP_TRANSPORT_IS_RECORDING) != 0;
            p.isLooping = (transport->flags & CLAP_TRANSPORT_IS_LOOP_ACTIVE) != 0;
        }

        // ---- events ----------------------------------------------------------
        const ParamEntry* entryFor (clap_id id) const
        {
            const auto found = paramIndex.find (id);
            return found == paramIndex.end() ? nullptr : &params[found->second];
        }

        // Applies the host's parameter value without sending it back to the host.
        void setFromHost (const ParamEntry& entry, double value)
        {
            const auto normalised = entry.toNormalised (value);
            if (entry.param->getValue() == normalised)
                return;
            suppressHostEcho = true;
            entry.param->setValueNotifyingHost (normalised);
            suppressHostEcho = false;
        }

        void handleEvent (const clap_event_header_t* event)
        {
            if (event->space_id != CLAP_CORE_EVENT_SPACE_ID)
                return;
            switch (event->type)
            {
                case CLAP_EVENT_PARAM_VALUE:
                {
                    const auto* e = reinterpret_cast<const clap_event_param_value_t*> (event);
                    if (const auto* entry = entryFor (e->param_id))
                        setFromHost (*entry, e->value);
                    break;
                }
                case CLAP_EVENT_PARAM_MOD:
                {
                    const auto* e = reinterpret_cast<const clap_event_param_mod_t*> (event);
                    if (const auto* entry = entryFor (e->param_id))
                        if (entry->modulation && entry->modulation->supportsMonophonicModulation())
                            entry->modulation->applyMonophonicModulation (e->amount);
                    break;
                }
                case CLAP_EVENT_TRANSPORT:
                    updateTransport (reinterpret_cast<const clap_event_transport_t*> (event));
                    break;
                default:
                    break;
            }
        }

        void flushOutgoing (const clap_output_events_t* out)
        {
            if (! out)
            {
                outgoing.clear();
                return;
            }
            for (const auto& change : outgoing)
            {
                if (change.type == CLAP_EVENT_PARAM_VALUE)
                {
                    clap_event_param_value_t e {};
                    e.header = { sizeof (e), 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0 };
                    e.param_id = change.id;
                    e.cookie = nullptr;
                    e.note_id = -1;
                    e.port_index = -1;
                    e.channel = -1;
                    e.key = -1;
                    e.value = change.value;
                    out->try_push (out, &e.header);
                }
                else
                {
                    clap_event_param_gesture_t e {};
                    e.header = { sizeof (e), 0, CLAP_CORE_EVENT_SPACE_ID, change.type, 0 };
                    e.param_id = change.id;
                    out->try_push (out, &e.header);
                }
            }
            outgoing.clear();
        }

        void flush (const clap_input_events_t* in, const clap_output_events_t* out)
        {
            if (in)
                for (uint32_t i = 0, n = in->size (in); i < n; ++i)
                    handleEvent (in->get (in, i));
            flushOutgoing (out);
            if (pageOpen)
                requestCallback(); // the page shows the host's values
        }

        // ---- process ---------------------------------------------------------
        clap_process_status process (const clap_process_t* p)
        {
            if (! activated)
                return CLAP_PROCESS_ERROR;
            updateTransport (p->transport);

            const auto* events = p->in_events;
            const uint32_t numEvents = events ? events->size (events) : 0;
            uint32_t nextEvent = 0;
            const uint32_t frames = std::min (p->frames_count, maxFrames);

            float* channels[2] {};
            if (p->audio_outputs_count > 0)
            {
                const auto& out = p->audio_outputs[0];
                for (uint32_t ch = 0; ch < 2; ++ch)
                    channels[ch] = ch < out.channel_count && out.data32 ? out.data32[ch] : scratch[ch].data();
            }
            else
            {
                channels[0] = scratch[0].data();
                channels[1] = scratch[1].data();
            }

            // JUCE processes in place: copy the main input to the output channels.
            const clap_audio_buffer_t* input = p->audio_inputs_count > 0 ? &p->audio_inputs[0] : nullptr;
            for (uint32_t ch = 0; ch < 2; ++ch)
            {
                const float* source = nullptr;
                if (input && input->data32 && input->channel_count > 0)
                    source = input->data32[std::min (ch, input->channel_count - 1)];
                if (source == channels[ch])
                    continue;
                if (source)
                    std::memcpy (channels[ch], source, frames * sizeof (float));
                else
                    std::memset (channels[ch], 0, frames * sizeof (float));
            }

            juce::MidiBuffer midi;
            for (uint32_t n = 0; n < frames;)
            {
                // clap-juce-extensions without CLAP_ALWAYS_SPLIT_BLOCK: split only at
                // parameter and transport events, rounded up to the resolution.
                const uint32_t chunk = [&]
                {
                    const uint32_t remaining = frames - n;
                    if (remaining <= eventResolution)
                        return remaining;
                    uint32_t untilNext = remaining;
                    for (uint32_t i = nextEvent; i < numEvents; ++i)
                    {
                        const auto* e = events->get (events, i);
                        if (e->time < n + eventResolution || e->space_id != CLAP_CORE_EVENT_SPACE_ID)
                            continue;
                        if (e->type == CLAP_EVENT_PARAM_VALUE || e->type == CLAP_EVENT_PARAM_MOD || e->type == CLAP_EVENT_TRANSPORT)
                        {
                            untilNext = e->time - n;
                            break;
                        }
                    }
                    const uint32_t blocks = (untilNext + eventResolution - 1) / eventResolution;
                    return std::min (blocks * eventResolution, remaining);
                }();

                while (nextEvent < numEvents && events->get (events, nextEvent)->time < n + chunk)
                    handleEvent (events->get (events, nextEvent++));

                float* offset[2] { channels[0] + n, channels[1] + n };
                juce::AudioBuffer<float> buffer (offset, 2, (int) chunk);
                const bool metering = pageOpen && guiVisible;
                if (metering)
                    measure (offset, chunk, squaresIn);
                if (processor->isSuspended())
                    buffer.clear();
                else
                    processor->processBlock (buffer, midi);
                midi.clear();
                if (metering)
                {
                    measure (offset, chunk, squaresOut);
                    meterFrames += chunk;
                    for (uint32_t i = 0; i < chunk; ++i)
                    {
                        scope[scopeAt] = 0.5f * (offset[0][i] + offset[1][i]);
                        scopeAt = (scopeAt + 1) % scopeSize;
                    }
                }
                n += chunk;
            }
            while (nextEvent < numEvents)
                handleEvent (events->get (events, nextEvent++));

            flushOutgoing (p->out_events);

            if (pageOpen && guiVisible)
            {
                framesSinceMeters += frames;
                if (framesSinceMeters >= (uint32_t) (sampleRate / 30.0))
                {
                    framesSinceMeters = 0;
                    metersDue = true;
                    requestCallback();
                }
            }
            if (hasPendingMessages())
                requestCallback();
            // As the desktop plug-in: tape noise and wow/flutter keep it running.
            return CLAP_PROCESS_CONTINUE;
        }

        static void measure (float* const* channels, uint32_t frames, double* squares)
        {
            for (int ch = 0; ch < 2; ++ch)
            {
                double sum = 0.0;
                for (uint32_t i = 0; i < frames; ++i)
                    sum += (double) channels[ch][i] * channels[ch][i];
                squares[ch] += sum;
            }
        }

        // ---- parameters --------------------------------------------------------
        bool paramInfo (uint32_t index, clap_param_info_t* info) const
        {
            if (index >= params.size() || ! info)
                return false;
            const auto& entry = params[index];
            *info = {};
            info->id = entry.id;
            info->cookie = nullptr;
            std::strncpy (info->name, entry.param->getName (CLAP_NAME_SIZE).toRawUTF8(), CLAP_NAME_SIZE - 1);
            info->module[0] = 0; // ChowTape's parameters have no groups
            if (entry.discrete)
            {
                const auto& range = entry.ranged->getNormalisableRange();
                info->min_value = range.start;
                info->max_value = range.end;
                info->default_value = entry.ranged->convertFrom0to1 (entry.param->getDefaultValue());
            }
            else
            {
                info->min_value = 0.0;
                info->max_value = 1.0;
                info->default_value = entry.param->getDefaultValue();
            }
            if (entry.param->isAutomatable())
                info->flags |= CLAP_PARAM_IS_AUTOMATABLE;
            if (entry.param->isBoolean() || entry.param->isDiscrete())
                info->flags |= CLAP_PARAM_IS_STEPPED;
            if (entry.modulation && entry.modulation->supportsMonophonicModulation())
                info->flags |= CLAP_PARAM_IS_MODULATABLE;
            return true;
        }

        bool paramValue (clap_id id, double* value) const
        {
            const auto* entry = entryFor (id);
            if (! entry || ! value)
                return false;
            *value = entry->toClap (entry->param->getValue());
            return true;
        }

        bool paramText (clap_id id, double value, char* display, uint32_t size) const
        {
            const auto* entry = entryFor (id);
            if (! entry || ! display || size == 0)
                return false;
            const auto text = entry->param->getText (entry->toNormalised (value), (int) size);
            std::strncpy (display, text.toRawUTF8(), size - 1);
            display[size - 1] = 0;
            return true;
        }

        bool paramFromText (clap_id id, const char* display, double* value) const
        {
            const auto* entry = entryFor (id);
            if (! entry || ! display || ! value)
                return false;
            *value = entry->toClap (entry->param->getValueForText (juce::String::fromUTF8 (display)));
            return true;
        }

        // ---- state -------------------------------------------------------------
        bool saveState (const clap_ostream_t* stream)
        {
            juce::MemoryBlock data;
            if (! guarded ("Saving the state failed", [&] { processor->getStateInformation (data); }))
                return false;
            auto* bytes = static_cast<const char*> (data.getData());
            size_t written = 0;
            while (written < data.getSize())
            {
                const auto result = stream->write (stream, bytes + written, data.getSize() - written);
                if (result <= 0)
                    return false;
                written += (size_t) result;
            }
            return true;
        }

        bool loadState (const clap_istream_t* stream)
        {
            juce::MemoryBlock data;
            char chunk[4096];
            for (;;)
            {
                const auto result = stream->read (stream, chunk, sizeof (chunk));
                if (result < 0)
                    return false;
                if (result == 0)
                    break;
                data.append (chunk, (size_t) result);
                if (data.getSize() > (size_t (16) << 20))
                    return false;
            }
            suppressHostEcho = true; // the host rescans instead
            const bool ok = guarded ("Loading the state failed", [&]
                                     { processor->setStateInformation (data.getData(), (int) data.getSize()); });
            suppressHostEcho = false;
            dispatchMessages();
            if (! ok)
                return false;
            if (hostParams)
                hostParams->rescan (host, CLAP_PARAM_RESCAN_VALUES | CLAP_PARAM_RESCAN_TEXT);
            presetChanged = true;
            if (pageOpen)
                onMainThread();
            return true;
        }

        // ---- webview -----------------------------------------------------------
        bool send (const juce::String& json)
        {
            if (! pageOpen || ! hostWebview)
                return false;
            const auto bytes = json.toStdString();
            if (! hostWebview->send (host, bytes.data(), (uint32_t) bytes.size()))
            {
                pageOpen = false;
                return false;
            }
            return true;
        }

        juce::var paramValueTriple (size_t index)
        {
            const auto& entry = params[index];
            const auto value = entry.param->getValue();
            juce::Array<juce::var> triple { (int) entry.id, value, entry.param->getText (value, 64) };
            return triple;
        }

        juce::var presetInfo()
        {
            auto& presets = processor->getPresetManager();
            auto* object = new juce::DynamicObject();
            const auto* current = presets.getCurrentPreset();
            object->setProperty ("index", current ? presets.getCurrentPresetIndex() : -1);
            object->setProperty ("name", current ? current->getName() : juce::String());
            object->setProperty ("dirty", presets.getIsDirty());
            return object;
        }

        juce::var presetList()
        {
            auto& presets = processor->getPresetManager();
            juce::Array<juce::var> list;
            int index = 0; // PresetManager indices count presets in map order
            for (const auto& [key, preset] : presets.getPresetMap())
            {
                juce::ignoreUnused (key);
                auto* object = new juce::DynamicObject();
                object->setProperty ("index", index++);
                object->setProperty ("name", preset.getName());
                object->setProperty ("vendor", preset.getVendor());
                object->setProperty ("category", preset.getCategory());
                object->setProperty ("user", preset.getPresetFile() != juce::File());
                list.add (object);
            }
            return list;
        }

        juce::var statusInfo()
        {
            auto* object = new juce::DynamicObject();
            object->setProperty ("sampleRate", activated ? sampleRate : 0.0);
            object->setProperty ("active", activated);
            object->setProperty ("processing", activated && processing);
            object->setProperty ("latency", (int) reportedLatency);
            return object;
        }

        void sendInit()
        {
            auto* message = new juce::DynamicObject();
            message->setProperty ("type", "init");
            message->setProperty ("version", Protocol::version);
            auto* pluginInfo = new juce::DynamicObject();
            pluginInfo->setProperty ("name", descriptor.name);
            pluginInfo->setProperty ("version", descriptor.version);
            message->setProperty ("plugin", pluginInfo);
            message->setProperty ("host", juce::String::fromUTF8 (host->name ? host->name : ""));

            juce::Array<juce::var> list;
            pageValues.resize (params.size());
            for (size_t i = 0; i < params.size(); ++i)
            {
                const auto& entry = params[i];
                auto* info = new juce::DynamicObject();
                info->setProperty ("id", (int) entry.id);
                info->setProperty ("key", entry.key);
                info->setProperty ("name", entry.param->getName (64));
                const char* kind = entry.param->isBoolean() ? "bool" : dynamic_cast<juce::AudioParameterChoice*> (entry.param) ? "choice" : "float";
                info->setProperty ("kind", kind);
                if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (entry.param))
                {
                    juce::Array<juce::var> choices;
                    for (const auto& name : choice->choices)
                        choices.add (name);
                    info->setProperty ("choices", choices);
                }
                info->setProperty ("steps", entry.param->isDiscrete() ? entry.param->getNumSteps() : 0);
                info->setProperty ("default", entry.param->getDefaultValue());
                const auto value = entry.param->getValue();
                info->setProperty ("value", value);
                info->setProperty ("text", entry.param->getText (value, 64));
                pageValues[i] = value;
                list.add (info);
            }
            message->setProperty ("params", list);
            message->setProperty ("presets", presetList());
            message->setProperty ("preset", presetInfo());
            message->setProperty ("userFolder", Wasi::hasPreopen ("/user"));
            message->setProperty ("status", statusInfo());
            auto* size = new juce::DynamicObject();
            size->setProperty ("width", (int) width);
            size->setProperty ("height", (int) height);
            message->setProperty ("size", size);
            send (toJson (message));
        }

        void sendStatus()
        {
            auto* message = new juce::DynamicObject();
            message->setProperty ("type", "status");
            const auto status = statusInfo();
            for (const auto& property : status.getDynamicObject()->getProperties())
                message->setProperty (property.name, property.value);
            send (toJson (message));
        }

        void sendPreset()
        {
            auto* message = new juce::DynamicObject();
            message->setProperty ("type", "preset");
            const auto info = presetInfo();
            for (const auto& property : info.getDynamicObject()->getProperties())
                message->setProperty (property.name, property.value);
            send (toJson (message));
        }

        void sendPresetList()
        {
            auto* message = new juce::DynamicObject();
            message->setProperty ("type", "presets");
            message->setProperty ("presets", presetList());
            send (toJson (message));
        }

        void sendParams (const std::vector<size_t>& indices)
        {
            if (indices.empty())
                return;
            juce::Array<juce::var> values;
            for (auto i : indices)
                values.add (paramValueTriple (i));
            auto* message = new juce::DynamicObject();
            message->setProperty ("type", "params");
            message->setProperty ("values", values);
            send (toJson (message));
        }

        // Values the page does not show yet: host automation, presets, mix groups.
        void sendParamChanges()
        {
            std::vector<size_t> changed;
            for (size_t i = 0; i < params.size() && i < pageValues.size(); ++i)
            {
                const auto value = params[i].param->getValue();
                if (value != pageValues[i])
                {
                    pageValues[i] = value;
                    changed.push_back (i);
                }
            }
            sendParams (changed);
        }

        void sendMeters()
        {
            const auto rms = [this] (const double* squares, int ch)
            { return meterFrames > 0 ? (float) std::sqrt (squares[ch] / meterFrames) : 0.0f; };
            auto* message = new juce::DynamicObject();
            message->setProperty ("type", "meters");
            message->setProperty ("input", juce::Array<juce::var> { rms (squaresIn, 0), rms (squaresIn, 1) });
            message->setProperty ("output", juce::Array<juce::var> { rms (squaresOut, 0), rms (squaresOut, 1) });
            juce::Array<juce::var> samples;
            samples.ensureStorageAllocated ((int) scopeSize);
            for (size_t i = 0; i < scopeSize; ++i)
                samples.add (std::round (scope[(scopeAt + i) % scopeSize] * 10000.0f) / 10000.0f);
            message->setProperty ("scope", samples);
            squaresIn[0] = squaresIn[1] = squaresOut[0] = squaresOut[1] = 0.0;
            meterFrames = 0;
            send (toJson (message));
        }

        void sendError (const juce::String& text)
        {
            auto* message = new juce::DynamicObject();
            message->setProperty ("type", "error");
            message->setProperty ("message", text);
            send (toJson (message));
        }

        bool receive (const void* buffer, uint32_t size)
        {
            if (! buffer || size == 0 || size > (1u << 20) || ! processor)
                return false;
            const auto message = juce::JSON::parse (juce::String::fromUTF8 (static_cast<const char*> (buffer), (int) size));
            const auto type = message["type"].toString();
            bool handled = true;
            guarded ("The editor message failed", [&]
                     {
                if (type == "hello")
                {
                    pageOpen = guiCreated;
                    if (! pageOpen)
                    {
                        handled = false;
                        return;
                    }
                    statusChanged = presetChanged = presetListChanged = metersDue = false;
                    sendInit();
                    // The editor shows meters: keep a plug-in the host let sleep running.
                    if (guiVisible)
                        host->request_process (host);
                }
                else if (type == "param")
                {
                    const auto* entry = entryFor ((clap_id) (uint32_t) (juce::int64) message["id"]);
                    if (! entry)
                        return;
                    const auto index = (size_t) (entry - params.data());
                    const auto value = juce::jlimit (0.0f, 1.0f, (float) (double) message["value"]);
                    entry->param->setValueNotifyingHost (value);
                    pageValues[index] = entry->param->getValue();
                    sendParams ({ index }); // the new text, and the snapped value of a stepped parameter
                }
                else if (type == "paramText")
                {
                    // A typed value, or a fixed one (the tape speed buttons): the
                    // parameter parses it as the desktop editor's text boxes do.
                    const auto* entry = entryFor ((clap_id) (uint32_t) (juce::int64) message["id"]);
                    if (! entry)
                        return;
                    const auto index = (size_t) (entry - params.data());
                    const auto value = entry->param->getValueForText (message["text"].toString());
                    entry->param->beginChangeGesture();
                    entry->param->setValueNotifyingHost (juce::jlimit (0.0f, 1.0f, value));
                    entry->param->endChangeGesture();
                    pageValues[index] = entry->param->getValue();
                    sendParams ({ index });
                }
                else if (type == "gesture")
                {
                    if (const auto* entry = entryFor ((clap_id) (uint32_t) (juce::int64) message["id"]))
                    {
                        if ((bool) message["begin"])
                            entry->param->beginChangeGesture();
                        else
                            entry->param->endChangeGesture();
                    }
                }
                else if (type == "preset")
                {
                    processor->getPresetManager().loadPresetFromIndex ((int) message["index"]);
                }
                else if (type == "savePreset")
                {
                    auto name = juce::File::createLegalFileName (message["name"].toString().trim());
                    auto& presets = processor->getPresetManager();
                    const auto folder = presets.getUserPresetPath();
                    if (name.isEmpty() || ! Wasi::hasPreopen ("/user") || folder == juce::File())
                    {
                        sendError ("Presets can only be saved when the host gives the plug-in a user folder.");
                        return;
                    }
                    folder.createDirectory();
                    presets.saveUserPreset (folder.getChildFile (name + ".chowpreset"));
                }
                else if (type == "resize")
                {
                    const auto w = (uint32_t) std::max (0, (int) message["width"]);
                    const auto h = (uint32_t) std::max (0, (int) message["height"]);
                    if (hostGui && w >= minimumWidth && h >= minimumHeight && w <= 8192 && h <= 8192)
                        hostGui->request_resize (host, w, h);
                }
                else
                {
                    handled = false;
                } });
            dispatchMessages();
            if (pageOpen)
                onMainThread();
            return handled;
        }

        bool getResource (const char* path, char* mime, uint32_t capacity, const clap_ostream_t* stream)
        {
            if (! safeResourcePath (path) || ! stream)
                return false;
            const std::string relative (path);
            if (relative == "/module.wasm") // the DSP module is not a page resource
                return false;
            const auto file = (bundlePath == "/" ? std::string() : bundlePath) + relative;
            std::ifstream input (file, std::ios::binary);
            if (! input)
                return false;
            if (mime && capacity)
            {
                std::strncpy (mime, mimeFor (relative), capacity - 1);
                mime[capacity - 1] = 0;
            }
            std::vector<char> chunk (1 << 16);
            while (input)
            {
                input.read (chunk.data(), (std::streamsize) chunk.size());
                const auto length = (size_t) input.gcount();
                size_t written = 0;
                while (written < length)
                {
                    const auto result = stream->write (stream, chunk.data() + written, length - written);
                    if (result <= 0)
                        return false;
                    written += (size_t) result;
                }
            }
            return input.eof();
        }

        bool adjustSize (uint32_t& w, uint32_t& h) const
        {
            w = std::clamp (w, minimumWidth, 8192u);
            h = std::clamp (h, minimumHeight, 8192u);
            return true;
        }

        void sendSize()
        {
            auto* message = new juce::DynamicObject();
            message->setProperty ("type", "size");
            message->setProperty ("width", (int) width);
            message->setProperty ("height", (int) height);
            send (toJson (message));
        }

        // ---- extensions ------------------------------------------------------
        static const void* extension (const char* id);
        friend struct Extensions;
    };

    struct Extensions
    {
        using P = ChowTapeWclap;

        static constexpr clap_plugin_params_t params {
            [] (const clap_plugin_t* p) -> uint32_t { return (uint32_t) P::self (p)->params.size(); },
            [] (const clap_plugin_t* p, uint32_t index, clap_param_info_t* info) { return P::self (p)->paramInfo (index, info); },
            [] (const clap_plugin_t* p, clap_id id, double* value) { return P::self (p)->paramValue (id, value); },
            [] (const clap_plugin_t* p, clap_id id, double value, char* display, uint32_t size)
            { return P::self (p)->paramText (id, value, display, size); },
            [] (const clap_plugin_t* p, clap_id id, const char* display, double* value)
            { return P::self (p)->paramFromText (id, display, value); },
            [] (const clap_plugin_t* p, const clap_input_events_t* in, const clap_output_events_t* out)
            { P::self (p)->flush (in, out); },
        };

        static constexpr clap_plugin_state_t state {
            [] (const clap_plugin_t* p, const clap_ostream_t* stream) { return stream && P::self (p)->saveState (stream); },
            [] (const clap_plugin_t* p, const clap_istream_t* stream) { return stream && P::self (p)->loadState (stream); },
        };

        // clap-juce-extensions' ports: "Input" (32768) and "Output" (1), stereo, main,
        // each the other's in-place pair.
        static constexpr clap_plugin_audio_ports_t audioPorts {
            [] (const clap_plugin_t*, bool) -> uint32_t { return 1; },
            [] (const clap_plugin_t*, uint32_t index, bool input, clap_audio_port_info_t* info)
            {
                if (index != 0 || ! info)
                    return false;
                *info = {};
                info->id = input ? inputPortId : outputPortId;
                std::strncpy (info->name, input ? "Input" : "Output", sizeof (info->name) - 1);
                info->flags = CLAP_AUDIO_PORT_IS_MAIN;
                info->channel_count = 2;
                info->port_type = CLAP_PORT_STEREO;
                info->in_place_pair = input ? outputPortId : inputPortId;
                return true;
            },
        };

        static constexpr clap_plugin_latency_t latency {
            [] (const clap_plugin_t* p) -> uint32_t { return P::self (p)->reportedLatency; }
        };

        static constexpr clap_plugin_tail_t tail {
            [] (const clap_plugin_t* p) -> uint32_t
            {
                auto* plugin = P::self (p);
                return (uint32_t) juce::roundToIntAccurate (plugin->sampleRate * plugin->processor->getTailLengthSeconds());
            }
        };

        // ChowTape renders offline with its own oversampling settings (os_render_*).
        static constexpr clap_plugin_render_t render {
            [] (const clap_plugin_t*) { return false; },
            [] (const clap_plugin_t* p, clap_plugin_render_mode mode)
            {
                P::self (p)->processor->setNonRealtime (mode != CLAP_RENDER_REALTIME);
                return true;
            },
        };

        static constexpr clap_plugin_gui_t gui {
            [] (const clap_plugin_t*, const char* api, bool) { return api && std::strcmp (api, CLAP_WINDOW_API_WEBVIEW) == 0; },
            [] (const clap_plugin_t*, const char** api, bool* floating)
            {
                if (! api || ! floating)
                    return false;
                *api = CLAP_WINDOW_API_WEBVIEW;
                *floating = false;
                return true;
            },
            [] (const clap_plugin_t* p, const char* api, bool)
            {
                if (! api || std::strcmp (api, CLAP_WINDOW_API_WEBVIEW) != 0)
                    return false;
                P::self (p)->guiCreated = true;
                return true;
            },
            [] (const clap_plugin_t* p)
            {
                auto* plugin = P::self (p);
                plugin->guiCreated = false;
                plugin->pageOpen = false;
            },
            // A webview uses logical sizes (clap.webview/3); the page follows the
            // device pixel ratio itself.
            [] (const clap_plugin_t*, double) { return false; },
            [] (const clap_plugin_t* p, uint32_t* w, uint32_t* h)
            {
                if (! w || ! h)
                    return false;
                *w = P::self (p)->width;
                *h = P::self (p)->height;
                return true;
            },
            [] (const clap_plugin_t*) { return true; },
            [] (const clap_plugin_t*, clap_gui_resize_hints_t* hints)
            {
                if (! hints)
                    return false;
                hints->can_resize_horizontally = true;
                hints->can_resize_vertically = true;
                hints->preserve_aspect_ratio = false;
                hints->aspect_ratio_width = defaultWidth;
                hints->aspect_ratio_height = defaultHeight;
                return true;
            },
            [] (const clap_plugin_t* p, uint32_t* w, uint32_t* h) { return w && h && P::self (p)->adjustSize (*w, *h); },
            [] (const clap_plugin_t* p, uint32_t w, uint32_t h)
            {
                if (w < minimumWidth || h < minimumHeight || w > 8192 || h > 8192)
                    return false;
                auto* plugin = P::self (p);
                if (w == plugin->width && h == plugin->height)
                    return true;
                plugin->width = w;
                plugin->height = h;
                if (plugin->pageOpen)
                    plugin->sendSize();
                return true;
            },
            [] (const clap_plugin_t*, const clap_window_t*) { return true; },
            [] (const clap_plugin_t*, const clap_window_t*) { return true; },
            [] (const clap_plugin_t*, const char*) {},
            [] (const clap_plugin_t* p)
            {
                auto* plugin = P::self (p);
                plugin->guiVisible = true;
                if (plugin->pageOpen)
                    plugin->host->request_process (plugin->host);
                return true;
            },
            [] (const clap_plugin_t* p)
            {
                P::self (p)->guiVisible = false;
                return true;
            },
        };

        static constexpr clap_plugin_webview_t webview {
            [] (const clap_plugin_t*, char* uri, uint32_t capacity) -> int32_t
            {
                static const char page[] = "/ui/index.html";
                if (uri && capacity)
                {
                    std::strncpy (uri, page, capacity - 1);
                    uri[capacity - 1] = 0;
                }
                return (int32_t) sizeof (page);
            },
            [] (const clap_plugin_t* p, const char* path, char* mime, uint32_t capacity, const clap_ostream_t* stream)
            { return P::self (p)->getResource (path, mime, capacity, stream); },
            [] (const clap_plugin_t* p, const void* buffer, uint32_t size) { return P::self (p)->receive (buffer, size); },
        };
    };

    const void* ChowTapeWclap::extension (const char* id)
    {
        if (! id)
            return nullptr;
        if (! std::strcmp (id, CLAP_EXT_PARAMS))
            return &Extensions::params;
        if (! std::strcmp (id, CLAP_EXT_STATE))
            return &Extensions::state;
        if (! std::strcmp (id, CLAP_EXT_AUDIO_PORTS))
            return &Extensions::audioPorts;
        if (! std::strcmp (id, CLAP_EXT_LATENCY))
            return &Extensions::latency;
        if (! std::strcmp (id, CLAP_EXT_TAIL))
            return &Extensions::tail;
        if (! std::strcmp (id, CLAP_EXT_RENDER))
            return &Extensions::render;
        if (! std::strcmp (id, CLAP_EXT_GUI))
            return &Extensions::gui;
        if (! std::strcmp (id, CLAP_EXT_WEBVIEW))
            return &Extensions::webview;
        return nullptr;
    }
} // namespace

const clap_plugin_t* createPlugin (const clap_host_t* host)
{
    auto* plugin = new (std::nothrow) ChowTapeWclap (host);
    return plugin ? &plugin->plugin : nullptr;
}
} // namespace ChowTape::Wclap
