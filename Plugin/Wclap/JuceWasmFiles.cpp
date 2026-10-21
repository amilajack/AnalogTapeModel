// SPDX-License-Identifier: GPL-3.0-or-later
// juce::File natives for the WCLAP module, which JUCE 6.1 leaves out on Wasm. Included
// by the overlay's juce_core.cpp (scripts/prepare_juce.py), inside its includes.
//
// The module's only files are the host's WASI preopens: the bundle, and optionally a
// private writable folder at /user. Home is $HOME, which the plug-in sets to /user
// when the host provides it, so ChowTape's settings and user presets live there.

#include <dirent.h>
#include <fnmatch.h>

// Copying, links and directory iteration are plain POSIX, which WASI answers
// (Wasi.cpp).
#include "juce_core/native/juce_linux_CommonFile.cpp"

namespace juce
{
bool File::isOnCDRomDrive() const { return false; }
bool File::isOnHardDisk() const { return true; }
bool File::isOnRemovableDrive() const { return false; }
String File::getVersion() const { return {}; }

File File::getSpecialLocation (const SpecialLocationType type)
{
    const auto home = []
    {
        if (const char* dir = getenv ("HOME"))
            return File (CharPointer_UTF8 (dir));
        return File ("/");
    };

    switch (type)
    {
        case userHomeDirectory:
            return home();
        case userDocumentsDirectory:
        case userMusicDirectory:
        case userMoviesDirectory:
        case userPicturesDirectory:
        case userDesktopDirectory:
            return home();
        case userApplicationDataDirectory:
        case commonApplicationDataDirectory:
        case commonDocumentsDirectory:
            return home().getChildFile (".config");
        case tempDirectory:
            return home().getChildFile (".tmp");
        case globalApplicationsDirectory:
            return File ("/");
        case invokedExecutableFile:
        case currentExecutableFile:
        case currentApplicationFile:
        case hostApplicationPath:
            return File ("/module.wasm");
        default:
            break;
    }

    return {};
}

bool File::moveToTrash() const { return deleteRecursively(); }
void File::revealToUser() const {}
bool Process::openDocument (const String&, const String&) { return false; }
} // namespace juce
