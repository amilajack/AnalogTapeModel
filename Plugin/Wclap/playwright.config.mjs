import {defineConfig} from '@playwright/test';
// Serves the repository root, so the test host reaches build-wclap/chowtape.wclap.
// CHOWTAPE_TEST_SILENT_OUTPUT=1 when the machine has no working audio output.
const launchOptions = {args: ['--autoplay-policy=no-user-gesture-required',
  ...(process.env.CHOWTAPE_TEST_SILENT_OUTPUT === '1' ? ['--disable-audio-output'] : [])]};
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.mjs/,
  workers: 1,
  use: {headless: true, launchOptions, baseURL: 'http://127.0.0.1:8137', viewport: {width: 900, height: 800},
    trace: 'retain-on-failure', screenshot: 'only-on-failure'},
  webServer: {command: 'python3 -m http.server 8137 --bind 127.0.0.1 --directory ../../', url: 'http://127.0.0.1:8137/Plugin/Wclap/tests/host/index.html', reuseExistingServer: true},
});
