// SPDX-License-Identifier: GPL-3.0-or-later
// clap_entry and the plug-in factory of the CHOWTapeModel WCLAP. One module instance
// hosts any number of plug-in instances, which share code, the STN model data and
// the mix groups (as instances in one desktop process do).
#include "Plugin.h"
#include <cstring>

namespace ChowTape::Wclap
{
std::string bundlePath = "/";

namespace
{
    // The desktop CLAP's features (Plugin/CMakeLists.txt), without the Windows one.
    const char* const features[] = { CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_DISTORTION,
                                     CLAP_PLUGIN_FEATURE_STEREO, CLAP_PLUGIN_FEATURE_MONO, nullptr };

    uint32_t pluginCount (const clap_plugin_factory_t*) { return 1; }

    const clap_plugin_descriptor_t* pluginDescriptor (const clap_plugin_factory_t*, uint32_t index)
    {
        return index == 0 ? &descriptor : nullptr;
    }

    const clap_plugin_t* create (const clap_plugin_factory_t*, const clap_host_t* host, const char* id)
    {
        if (! host || ! id || std::strcmp (id, descriptor.id) != 0 || ! clap_version_is_compatible (host->clap_version))
            return nullptr;
        return createPlugin (host);
    }

    const clap_plugin_factory_t factory { pluginCount, pluginDescriptor, create };

    bool init (const char* path)
    {
        bundlePath = path && *path ? path : "/";
        while (bundlePath.size() > 1 && bundlePath.back() == '/')
            bundlePath.pop_back();
        return true;
    }

    void deinit() {}

    const void* getFactory (const char* id)
    {
        if (id && std::strcmp (id, CLAP_PLUGIN_FACTORY_ID) == 0)
            return &factory;
        return nullptr;
    }
} // namespace

const clap_plugin_descriptor_t descriptor {
    CLAP_VERSION_INIT,
    "org.chowdsp.CHOWTapeModel", // the desktop CLAP's id, so projects move between them
    "CHOWTapeModel",
    "chowdsp",
    "https://chowdsp.com",
    "https://chowdsp.com/manuals/ChowTapeManual.pdf",
    "https://github.com/jatinchowdhury18/AnalogTapeModel",
    JucePlugin_VersionString,
    "Physical modelling signal processing for analog tape recording (WebAssembly)",
    features,
};
} // namespace ChowTape::Wclap

extern "C" CLAP_EXPORT const clap_plugin_entry_t clap_entry {
    CLAP_VERSION_INIT,
    ChowTape::Wclap::init,
    ChowTape::Wclap::deinit,
    ChowTape::Wclap::getFactory,
};
