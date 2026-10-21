// SPDX-License-Identifier: GPL-3.0-or-later
// Runs upstream's headless unit tests (Source/Headless/UnitTests) on the Wasm build:
//   node tests/unit-tests.mjs [TestName...]
// The tests are the desktop ones; only the runner is new (the desktop runner is a
// juce::ConsoleApplication command of the headless app).
#include "JuceWasm.h"
#include <iostream>

namespace
{
struct ConsoleRunner : juce::UnitTestRunner
{
    void logMessage (const juce::String& message) override { std::cout << message << std::endl; }
};
} // namespace

int main (int argc, char** argv)
{
    ChowTape::Wclap::startJuce();
    juce::Array<juce::UnitTest*> tests;
    for (auto* test : juce::UnitTest::getAllTests())
    {
        bool wanted = argc < 2;
        for (int i = 1; i < argc; ++i)
            wanted = wanted || test->getName() == argv[i];
        if (wanted)
            tests.add (test);
    }

    ConsoleRunner runner;
    runner.setAssertOnFailure (false);
    runner.runTests (tests, 0x12345);

    int failures = 0;
    for (int i = 0; i < runner.getNumResults(); ++i)
        failures += runner.getResult (i)->failures;
    std::cout << (failures == 0 ? "All tests passed" : juce::String (failures) + " failures") << std::endl;
    juce::MessageManager::deleteInstance();
    return failures == 0 ? 0 : 1;
}
