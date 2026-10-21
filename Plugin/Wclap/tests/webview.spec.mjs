// SPDX-License-Identifier: GPL-3.0-or-later
// The editor page in a WCLAP host: the module in a DSP worker, audio through an
// AudioWorklet, and the page in a sandboxed srcdoc frame (opaque origin) built from
// get_resource (tests/host). Run after scripts/build.sh and scripts/package.py:
//   npx playwright test
import {expect, test} from '@playwright/test';

const HOST = '/Plugin/Wclap/tests/host/index.html';

async function start(page) {
  await page.goto(HOST);
  const result = await page.evaluate(() => wclapHost.start());
  const editor = page.frameLocator('iframe');
  await expect(editor.locator('#editor')).toHaveAttribute('aria-busy', 'false');
  return {editor, result};
}

const param = (page, name) => page.evaluate(name => wclapHost.call('paramByName', {name}), name);
const stats = page => page.evaluate(() => wclapHost.call('stats'));

test('the editor opens with the desktop layout and the plug-in\'s values', async ({page}) => {
  const {editor, result} = await start(page);
  expect(result.info.params).toBe(52);
  await expect(editor.locator('.tabs button')).toHaveText(['Gain', 'Filters', 'Stereo', 'Tape', 'Comp', 'Tone', 'Loss', 'Degrade', 'CHEW', 'Flutter', 'Wow']);
  await expect(editor.locator('.knob', {hasText: 'Drive'}).locator('.value-text')).toHaveText('0.50');
  await expect(editor.locator('#preset-name')).toHaveText('Default');
  await expect(editor.locator('#oversampling .value')).toHaveText('2x');
  await page.screenshot({path: test.info().outputPath('editor.png')});
});

test('dragging a knob reaches the DSP and the host, with gestures', async ({page}) => {
  const {editor} = await start(page);
  await stats(page);
  const knob = editor.locator('.knob', {hasText: 'Drive'}).locator('svg');
  const box = await knob.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, {steps: 6});
  await page.mouse.up();
  await expect.poll(async () => (await param(page, 'Tape Drive')).value).toBeGreaterThan(0.7);
  const drive = await param(page, 'Tape Drive');
  await expect(editor.locator('.knob', {hasText: 'Drive'}).locator('.value-text')).toHaveText(drive.text);
  const events = (await stats(page)).outEvents.filter(e => e.id === drive.id);
  expect(events[0].type).toBe(7); // gesture begin
  expect(events.at(-1).type).toBe(8); // gesture end
  expect(events.some(e => e.type === 5)).toBe(true);
});

test('host automation moves the editor', async ({page}) => {
  const {editor} = await start(page);
  const saturation = await param(page, 'Tape Saturation');
  await page.evaluate(id => wclapHost.call('automate', {id, value: 0.9}), saturation.id);
  await expect(editor.locator('.knob', {hasText: 'Saturation'}).locator('.value-text')).toHaveText('0.90');
});

test('power buttons, tabs, text buttons and the tape speed buttons', async ({page}) => {
  const {editor} = await start(page);
  const tape = editor.locator('.tab[data-tab="Tape"]');
  await tape.locator('.power').click();
  await expect(tape).toHaveClass(/off/);
  await expect.poll(async () => (await param(page, 'Tape On/Off')).value).toBe(0);

  // The filters start off, and their controls are disabled until they are on.
  await editor.locator('.tabs button', {hasText: 'Filters'}).click();
  const filters = editor.locator('.tab[data-tab="Filters"]');
  await expect(filters).toHaveClass(/off/);
  await filters.locator('.power').click();
  await expect(filters).not.toHaveClass(/off/);
  const makeup = editor.locator('.tab[data-tab="Filters"] .text-button', {hasText: 'Makeup'});
  await makeup.click();
  await expect(makeup).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await param(page, 'Input Cut Makeup')).value).toBe(1);

  await editor.locator('.speed-buttons button', {hasText: '30'}).click();
  await expect.poll(async () => (await param(page, 'Tape Speed')).text).toBe('30.00');
  await expect(editor.locator('.slider', {hasText: 'Speed'}).locator('.value-text')).toHaveText('30.00');
});

test('typing a value sets it as the desktop text box does', async ({page}) => {
  const {editor} = await start(page);
  const text = editor.locator('.knob', {hasText: 'Input Gain'}).locator('.value-text');
  await text.click();
  await text.locator('input').fill('-6');
  await text.locator('input').press('Enter');
  await expect(text).toHaveText('-6.00 dB');
  await expect.poll(async () => (await param(page, 'Input Gain')).text).toBe('-6.00 dB');
});

test('presets: the menu, the arrows and the hysteresis mode', async ({page}) => {
  const {editor} = await start(page);
  await editor.locator('#preset-name').click();
  await editor.locator('#menu .item', {hasText: /^LoFi$/}).first().click();
  await expect(editor.locator('#preset-name')).toHaveText('LoFi');
  await editor.locator('#preset-next').click();
  await expect(editor.locator('#preset-name')).not.toHaveText('LoFi');
  const mode = await param(page, 'Tape Mode');
  await editor.locator('#mode').selectOption({index: 4});
  await expect.poll(async () => (await param(page, 'Tape Mode')).value).toBe(4);
  expect(mode.max).toBe(5);
  await expect(editor.locator('#preset-name')).toHaveText(/\*$/); // dirty
});

test('oversampling menu sets the factor', async ({page}) => {
  const {editor} = await start(page);
  await editor.locator('#oversampling').click();
  await editor.locator('#menu .item', {hasText: /^4x$/}).first().click();
  await expect(editor.locator('#oversampling .value')).toHaveText('4x');
  await expect.poll(async () => (await param(page, 'Oversampling Factor')).text).toBe('4x');
});

test('meters and the scope follow the audio', async ({page}) => {
  const {editor} = await start(page);
  await expect(editor.locator('#level-in')).toHaveText(/IN: -(9|10)\.\d dB/);
  await expect(editor.locator('#level-out')).not.toHaveText('OUT: -inf dB');
  await page.evaluate(() => wclapHost.call('source', {kind: 'silence'}));
  await expect(editor.locator('#level-in')).toHaveText('IN: -inf dB');
});

test('a user preset is saved in the plug-in\'s user folder', async ({page}) => {
  const {editor} = await start(page);
  await editor.locator('#settings').click();
  await editor.locator('#menu .item', {hasText: 'Save Preset As'}).click();
  await editor.locator('#dialog-input').fill('Browser Tape');
  await editor.locator('#dialog-save').click();
  await expect(editor.locator('#preset-name')).toHaveText('Browser Tape');
  const files = await page.evaluate(() => wclapHost.call('userFiles'));
  expect(files.some(f => f.path === '/Presets/Browser Tape.chowpreset' && f.size > 0)).toBe(true);
  await editor.locator('#preset-name').click();
  await expect(editor.locator('#menu .heading', {hasText: 'User'})).toBeVisible();
});

test('host state loads update the editor, and a reopened window shows the plug-in\'s values', async ({page}) => {
  const {editor} = await start(page);
  const state = await page.evaluate(() => wclapHost.call('saveState'));
  const drive = await param(page, 'Tape Drive');
  await page.evaluate(id => wclapHost.call('automate', {id, value: 0.2}), drive.id);
  await expect(editor.locator('.knob', {hasText: 'Drive'}).locator('.value-text')).toHaveText('0.20');
  await page.evaluate(bytes => wclapHost.call('loadState', {bytes: new Uint8Array(bytes)}), [...state]);
  await expect(editor.locator('.knob', {hasText: 'Drive'}).locator('.value-text')).toHaveText('0.50');
  await page.evaluate(id => wclapHost.call('automate', {id, value: 0.35}), drive.id);
  await page.evaluate(() => wclapHost.reopen());
  const reopened = page.frameLocator('iframe');
  await expect(reopened.locator('#editor')).toHaveAttribute('aria-busy', 'false');
  await expect(reopened.locator('.knob', {hasText: 'Drive'}).locator('.value-text')).toHaveText('0.35');
});

test('the host resizes the window and the editor scales to it', async ({page}) => {
  const {editor} = await start(page);
  const size = await page.evaluate(() => wclapHost.setSize(1080, 930));
  expect(size).toMatchObject({ok: true, width: 1080, height: 930});
  await expect.poll(() => editor.locator('#editor').evaluate(e => getComputedStyle(e).transform)).toMatch(/^matrix\(1\.5, 0, 0, 1\.5/);
});

test('the editor frame makes no network requests', async ({page}) => {
  const fromFrame = [];
  page.on('request', request => {
    let frame = null;
    try { frame = request.frame(); } catch { return; } // a worker's request: the host's own
    if (frame !== page.mainFrame()) fromFrame.push(request.url());
  });
  await start(page);
  await page.waitForTimeout(500);
  expect(fromFrame).toEqual([]);
});
