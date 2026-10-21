// SPDX-License-Identifier: GPL-3.0-or-later
// The CHOWTapeModel WCLAP editor. It talks to the plug-in only through clap.webview/3
// messages: UTF-8 JSON in ArrayBuffers, posted to window.parent and received as
// message events (Wclap/Protocol.h describes them). The layout follows the desktop
// editor (Source/GUI/Assets/gui.xml).
'use strict';

(() => {
  const TOOLTIPS = window.CHOWTAPE_TOOLTIPS || {};

  // The desktop editor's panels: tabs of knobs (or sliders), buttons and a power button.
  const LAYOUT = [
    [
      {tab: 'Gain', controls: [{knob: 'ingain', caption: 'Input Gain'}, {knob: 'drywet', caption: 'Dry/Wet', wet: true}, {knob: 'outgain', caption: 'Output Gain'}]},
      {tab: 'Filters', power: 'ifilt_onoff', controls: [{knob: 'ifilt_low', caption: 'Low Cut'}, {knob: 'ifilt_high', caption: 'High Cut'}, {button: 'ifilt_makeup', text: 'Makeup'}]},
      {tab: 'Stereo', controls: [{button: 'mid_side', text: 'Mid/Side', off: 'Stereo'}, {knob: 'stereo_balance', caption: 'Balance'}, {button: 'stereo_makeup', text: 'Makeup'}]},
    ],
    [
      {tab: 'Tape', power: 'hyst_onoff', controls: [{knob: 'width', caption: 'Bias'}, {knob: 'sat', caption: 'Saturation'}, {knob: 'drive', caption: 'Drive'}]},
      {tab: 'Comp', power: 'comp_onoff', controls: [{knob: 'comp_amt', caption: 'Amount'}, {knob: 'comp_attack', caption: 'Attack'}, {knob: 'comp_release', caption: 'Release'}]},
      {tab: 'Tone', power: 'tone_onoff', controls: [{knob: 'h_treble', caption: 'Treble'}, {knob: 'h_bass', caption: 'Bass'}, {knob: 'h_tfreq', caption: 'Frequency'}]},
    ],
    [
      {tab: 'Loss', power: 'loss_onoff', controls: [{slider: 'gap', caption: 'Gap [microns]'}, {slider: 'thick', caption: 'Thickness [microns]'},
        {slider: 'spacing', caption: 'Spacing [microns]'}, {slider: 'azimuth', caption: 'Azimuth [degrees]'}, {slider: 'speed', caption: 'Speed [ips]'},
        {speeds: 'speed', values: ['3.75', '7.5', '15', '30']}]},
      {tab: 'Degrade', power: 'deg_onoff', controls: [{knob: 'deg_depth', caption: 'Depth', small: true, extra: {button: 'deg_point1x', text: '0.1x'}},
        {knob: 'deg_amt', caption: 'Amount', small: true}, {knob: 'deg_var', caption: 'Variance', small: true}, {knob: 'deg_env', caption: 'Envelope', small: true}]},
      {tab: 'CHEW', power: 'chew_onoff', controls: [{knob: 'chew_depth', caption: 'Depth'}, {knob: 'chew_freq', caption: 'Frequency'}, {knob: 'chew_var', caption: 'Variance'}]},
    ],
    [
      {tab: 'Flutter', power: 'flutter_onoff', controls: [{knob: 'depth', caption: 'Depth'}, {knob: 'rate', caption: 'Rate'}]},
      {tab: 'Wow', power: 'flutter_onoff', controls: [{knob: 'wow_depth', caption: 'Depth', small: true}, {knob: 'wow_rate', caption: 'Rate', small: true},
        {knob: 'wow_var', caption: 'Variance', small: true}, {knob: 'wow_drift', caption: 'Drift', small: true}]},
    ],
  ];

  const $ = id => document.getElementById(id);
  const editor = $('editor');
  const params = new Map();   // key -> {info, value, text, views: Set}
  const byId = new Map();     // CLAP id -> key
  let presets = [], preset = {index: -1, name: '', dirty: false}, userFolder = false, initialised = false;

  // ---- messages --------------------------------------------------------------
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  function send(message) {
    const bytes = encoder.encode(JSON.stringify(message));
    window.parent.postMessage(bytes.buffer, '*');
  }

  window.addEventListener('message', event => {
    let data = event.data;
    if (ArrayBuffer.isView(data)) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (!(data instanceof ArrayBuffer)) return;
    let message;
    try { message = JSON.parse(decoder.decode(data)); } catch { return; }
    handle(message);
  });

  function handle(message) {
    switch (message.type) {
    case 'init': init(message); break;
    case 'params': for (const [id, value, text] of message.values) update(byId.get(id >>> 0), value, text); break;
    case 'preset': setPreset(message); break;
    case 'presets': presets = message.presets; break;
    case 'status': setStatus(message); break;
    case 'meters': drawMeters(message); break;
    case 'size': fit(); break;
    case 'error': showMessage(message.message); break;
    }
  }

  // Ask until the plug-in answers: the host may connect the page after it loads.
  let helloTimer = 0;
  function hello() {
    if (initialised) return;
    send({type: 'hello'});
    helloTimer = setTimeout(hello, 500);
  }

  // ---- parameters --------------------------------------------------------------
  function param(key) { return params.get(key); }

  function update(key, value, text) {
    const p = param(key);
    if (!p) return;
    p.value = value;
    if (text !== undefined) p.text = text;
    for (const view of p.views) view(p);
  }

  function bind(key, view) {
    const p = param(key);
    if (!p) return;
    p.views.add(view);
    view(p);
  }

  function setValue(key, value) {
    const p = param(key);
    if (!p) return;
    value = Math.min(1, Math.max(0, value));
    if (p.info.steps > 1) value = Math.round(value * (p.info.steps - 1)) / (p.info.steps - 1);
    if (value === p.value) return;
    update(key, value);
    send({type: 'param', id: p.info.id, value});
  }

  function gesture(key, begin) {
    const p = param(key);
    if (p) send({type: 'gesture', id: p.info.id, begin});
  }

  function setText(key, text) {
    const p = param(key);
    if (p) send({type: 'paramText', id: p.info.id, text});
  }

  // ---- controls --------------------------------------------------------------
  const SVG = 'http://www.w3.org/2000/svg';
  function svg(tag, attributes = {}, parent) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attributes)) node.setAttribute(k, v);
    parent?.appendChild(node);
    return node;
  }

  // JUCE's default rotary range: 1.2 pi to 2.8 pi.
  const START = -0.8 * Math.PI, END = 0.8 * Math.PI;
  function arc(cx, cy, r, from, to) {
    const point = a => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const [x0, y0] = point(from), [x1, y1] = point(to);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
  }

  function tooltip(element, key) {
    const text = TOOLTIPS[key];
    if (!text) return;
    element.addEventListener('pointerenter', () => { $('tooltip').textContent = text; });
    element.addEventListener('pointerleave', () => { $('tooltip').textContent = ''; });
  }

  // Drags: vertical and horizontal movement both turn a knob; shift is fine control.
  function draggable(element, key, {pixels = 200, horizontalOnly = false, absolute = null} = {}) {
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const p = param(key);
      if (!p) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      gesture(key, true);
      let last = {x: event.clientX, y: event.clientY};
      let value = p.value;
      if (absolute) { value = absolute(event); setValue(key, value); }
      const move = e => {
        const scale = (e.shiftKey ? 0.15 : 1) / pixels / currentScale;
        const delta = horizontalOnly ? (e.clientX - last.x) : (e.clientX - last.x) - (e.clientY - last.y);
        last = {x: e.clientX, y: e.clientY};
        value = Math.min(1, Math.max(0, value + delta * scale));
        setValue(key, value);
      };
      const up = () => {
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', up);
        element.removeEventListener('pointercancel', up);
        gesture(key, false);
      };
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', up);
      element.addEventListener('pointercancel', up);
    });
    element.addEventListener('dblclick', () => {
      const p = param(key);
      if (!p) return;
      gesture(key, true);
      setValue(key, p.info.default);
      gesture(key, false);
    });
    element.addEventListener('wheel', event => {
      const p = param(key);
      if (!p) return;
      event.preventDefault();
      gesture(key, true);
      setValue(key, p.value - Math.sign(event.deltaY) * (event.shiftKey ? 0.005 : 0.02));
      gesture(key, false);
    }, {passive: false});
  }

  // Click the value to type one, as in the desktop editor's text boxes.
  function editableText(element, key) {
    element.addEventListener('click', () => {
      const p = param(key);
      if (!p || element.querySelector('input')) return;
      const input = document.createElement('input');
      input.value = p.text;
      element.textContent = '';
      element.appendChild(input);
      input.focus();
      input.select();
      let done = false;
      const finish = commit => {
        if (done) return;
        done = true;
        const text = input.value;
        element.textContent = param(key).text;
        if (commit && text.trim()) setText(key, text.trim());
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
    });
  }

  function knob(spec) {
    const root = document.createElement('div');
    root.className = 'knob';
    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = spec.caption;
    const size = spec.small ? 0.78 : 1;
    const drawing = svg('svg', {viewBox: '0 0 82 74', role: 'slider', tabindex: '0', 'aria-label': spec.caption});
    drawing.style.width = `${82 * size}px`;
    drawing.style.height = `${74 * size}px`;
    const cx = 41, cy = 39, r = 33;
    svg('path', {d: arc(cx, cy, r, START, END), stroke: 'var(--track-bg)', 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round'}, drawing);
    const fill = svg('path', {stroke: spec.wet ? 'var(--wet)' : 'var(--track)', 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round'}, drawing);
    const defs = svg('defs', {}, drawing);
    const gradientId = 'knob-' + spec.knob;
    const gradient = svg('linearGradient', {id: gradientId, x1: '0', y1: '0', x2: '1', y2: '1'}, defs);
    svg('stop', {offset: '0', 'stop-color': '#b5b5bf'}, gradient);
    svg('stop', {offset: '1', 'stop-color': '#606068'}, gradient);
    svg('circle', {cx, cy, r: 24, fill: `url(#${gradientId})`, stroke: 'rgba(255,255,255,0.25)', 'stroke-width': 1.5}, drawing);
    const pointer = svg('rect', {x: cx - 1.75, y: cy - 24, width: 3.5, height: 25, rx: 1.75, fill: '#fff'}, drawing);
    const text = document.createElement('div');
    text.className = 'value-text';
    root.append(caption, drawing);
    if (spec.extra) {
      const row = document.createElement('div');
      row.className = 'inline-row';
      row.append(text, toggle(spec.extra));
      root.append(row);
    } else {
      root.append(text);
    }
    bind(spec.knob, p => {
      const angle = START + (END - START) * p.value;
      fill.setAttribute('d', p.value > 0.001 ? arc(cx, cy, r, START, angle) : '');
      pointer.setAttribute('transform', `rotate(${angle * 180 / Math.PI} ${cx} ${cy})`);
      if (!text.querySelector('input')) text.textContent = p.text;
      drawing.setAttribute('aria-valuetext', p.text);
    });
    keyboard(drawing, spec.knob);
    draggable(drawing, spec.knob);
    editableText(text, spec.knob);
    tooltip(root, spec.knob);
    return root;
  }

  function slider(spec) {
    const root = document.createElement('div');
    root.className = 'slider';
    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = spec.caption;
    const rail = document.createElement('div');
    rail.className = 'rail';
    rail.setAttribute('role', 'slider');
    rail.setAttribute('tabindex', '0');
    rail.setAttribute('aria-label', spec.caption);
    const fill = document.createElement('div');
    fill.className = 'fill';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    rail.append(fill, thumb);
    const text = document.createElement('div');
    text.className = 'value-text';
    root.append(caption, rail, text);
    bind(spec.slider, p => {
      fill.style.width = `${p.value * 100}%`;
      thumb.style.left = `${p.value * 100}%`;
      if (!text.querySelector('input')) text.textContent = p.text;
      rail.setAttribute('aria-valuetext', p.text);
    });
    const absolute = event => {
      const box = rail.getBoundingClientRect();
      return (event.clientX - box.left) / box.width;
    };
    keyboard(rail, spec.slider);
    draggable(rail, spec.slider, {pixels: 120, horizontalOnly: true, absolute});
    editableText(text, spec.slider);
    tooltip(root, spec.slider);
    return root;
  }

  function keyboard(element, key) {
    element.addEventListener('keydown', event => {
      const p = param(key);
      if (!p) return;
      const step = event.shiftKey ? 0.005 : 0.02;
      const delta = {ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step}[event.key];
      if (delta === undefined) return;
      event.preventDefault();
      gesture(key, true);
      setValue(key, p.value + delta);
      gesture(key, false);
    });
  }

  function toggle(spec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button';
    bind(spec.button, p => {
      const on = p.value >= 0.5;
      button.setAttribute('aria-pressed', String(on));
      button.textContent = on || !spec.off ? spec.text : spec.off;
    });
    button.addEventListener('click', () => {
      const p = param(spec.button);
      if (!p) return;
      gesture(spec.button, true);
      setValue(spec.button, p.value >= 0.5 ? 0 : 1);
      gesture(spec.button, false);
    });
    tooltip(button, spec.button);
    return button;
  }

  function speedButtons(spec) {
    const row = document.createElement('div');
    row.className = 'speed-buttons';
    for (const value of spec.values) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = value;
      button.addEventListener('click', () => setText(spec.speeds, value));
      row.append(button);
    }
    return row;
  }

  const POWER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/><path d="M6.6 6.6a7.5 7.5 0 1 0 10.8 0" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>';

  function power(key, tab) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'power';
    button.innerHTML = POWER;
    bind(key, p => {
      const on = p.value >= 0.5;
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', `${param(key).info.name}: ${on ? 'on' : 'off'}`);
      tab.classList.toggle('off', !on);
    });
    button.addEventListener('click', () => {
      const p = param(key);
      gesture(key, true);
      setValue(key, p.value >= 0.5 ? 0 : 1);
      gesture(key, false);
    });
    return button;
  }

  function buildPanels() {
    const main = $('panels');
    main.textContent = '';
    LAYOUT.forEach((tabs, panelIndex) => {
      const panel = document.createElement('section');
      panel.className = 'panel';
      const bar = document.createElement('div');
      bar.className = 'tabs';
      bar.setAttribute('role', 'tablist');
      panel.append(bar);
      const pages = [];
      tabs.forEach((spec, index) => {
        const tabButton = document.createElement('button');
        tabButton.type = 'button';
        tabButton.textContent = spec.tab;
        tabButton.setAttribute('role', 'tab');
        bar.append(tabButton);
        const page = document.createElement('div');
        page.className = 'tab';
        page.setAttribute('role', 'tabpanel');
        page.dataset.tab = spec.tab;
        const controls = document.createElement('div');
        controls.className = 'controls';
        for (const control of spec.controls) {
          if (control.knob) controls.append(knob(control));
          else if (control.slider) controls.append(slider(control));
          else if (control.button) controls.append(toggle(control));
          else if (control.speeds) controls.append(speedButtons(control));
        }
        page.append(controls);
        if (spec.power) page.append(power(spec.power, page));
        panel.append(page);
        pages.push([tabButton, page]);
        tabButton.addEventListener('click', () => select(index));
      });
      const remembered = 'chowtape.tab.' + panelIndex;
      const select = index => {
        pages.forEach(([button, page], i) => {
          button.setAttribute('aria-selected', String(i === index));
          page.hidden = i !== index;
        });
        try { sessionStorage.setItem(remembered, String(index)); } catch {}
      };
      let initial = 0;
      try { initial = Math.min(tabs.length - 1, Number(sessionStorage.getItem(remembered)) || 0); } catch {}
      select(initial);
      main.append(panel);
    });
  }

  // ---- the bar ---------------------------------------------------------------
  function choiceSelect(element, key) {
    const p = param(key);
    if (!p) return;
    element.textContent = '';
    const choices = p.info.choices || [];
    choices.forEach((name, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = name;
      element.append(option);
    });
    bind(key, q => { element.value = String(Math.round(q.value * Math.max(1, choices.length - 1))); });
    element.onchange = () => {
      gesture(key, true);
      setValue(key, Number(element.value) / Math.max(1, choices.length - 1));
      gesture(key, false);
    };
    tooltip(element.parentElement, key);
  }

  function openMenu(anchor, build) {
    const menu = $('menu');
    menu.textContent = '';
    build(menu);
    menu.hidden = false;
    const box = anchor.getBoundingClientRect(), editorBox = editor.getBoundingClientRect();
    const toLocal = v => v / currentScale;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const menuWidth = menu.offsetWidth, menuHeight = menu.offsetHeight;
    let left = toLocal(box.left - editorBox.left);
    let top = toLocal(box.top - editorBox.top) - menuHeight - 4;
    left = Math.max(4, Math.min(left, editor.offsetWidth - menuWidth - 4));
    if (top < 4) top = toLocal(box.bottom - editorBox.top) + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const close = event => {
      if (event && menu.contains(event.target)) return;
      menu.hidden = true;
      document.removeEventListener('pointerdown', close, true);
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
    menu.close = () => close();
    menu.querySelector('.item')?.focus({preventScroll: true});
  }

  function menuItem(menu, label, {checked = null, disabled = false, action} = {}) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'item';
    item.textContent = label;
    if (checked !== null) item.setAttribute('aria-checked', String(checked));
    item.setAttribute('role', checked !== null ? 'menuitemradio' : 'menuitem');
    item.disabled = disabled;
    item.addEventListener('click', () => { menu.close(); action?.(); });
    menu.append(item);
    return item;
  }

  function menuHeading(menu, text) {
    const heading = document.createElement('div');
    heading.className = 'heading';
    heading.textContent = text;
    menu.append(heading);
  }

  function choiceItems(menu, key, heading) {
    const p = param(key);
    if (!p) return;
    menuHeading(menu, heading);
    const choices = p.info.choices || ['Off', 'On'];
    const count = Math.max(1, choices.length - 1);
    choices.forEach((name, i) => menuItem(menu, name, {
      checked: Math.round(p.value * count) === i,
      action: () => { gesture(key, true); setValue(key, i / count); gesture(key, false); },
    }));
  }

  function buildBar() {
    const oversampling = $('oversampling');
    const label = () => {
      const factor = param('os_factor'), mode = param('os_mode');
      oversampling.querySelector('.value').textContent = factor ? factor.text : '';
      oversampling.title = mode ? mode.text : '';
    };
    bind('os_factor', label);
    bind('os_mode', label);
    oversampling.onclick = () => openMenu(oversampling, menu => {
      choiceItems(menu, 'os_factor', 'Oversampling');
      choiceItems(menu, 'os_mode', 'Mode');
      menu.append(document.createElement('hr'));
      choiceItems(menu, 'os_render_factor', 'Render oversampling');
      choiceItems(menu, 'os_render_mode', 'Render mode');
      const like = param('os_render_like_realtime');
      if (like) menuItem(menu, 'Render like real-time', {checked: like.value >= 0.5, action: () => {
        gesture('os_render_like_realtime', true);
        setValue('os_render_like_realtime', like.value >= 0.5 ? 0 : 1);
        gesture('os_render_like_realtime', false);
      }});
    });
    choiceSelect($('mode'), 'mode');
    choiceSelect($('mix-group'), 'mix_group');

    $('preset-prev').onclick = () => stepPreset(-1);
    $('preset-next').onclick = () => stepPreset(1);
    $('preset-name').onclick = () => openMenu($('preset-name'), menu => {
      const groups = new Map();
      for (const p of presets) {
        const group = p.user ? 'User' : (p.vendor || 'Factory') + (p.category ? ' / ' + p.category : '');
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(p);
      }
      for (const [group, list] of groups) {
        menuHeading(menu, group);
        for (const p of list) menuItem(menu, p.name, {checked: p.index === preset.index, action: () => send({type: 'preset', index: p.index})});
      }
    });
    $('settings').onclick = () => openMenu($('settings'), menu => {
      menuItem(menu, 'Save Preset As…', {disabled: !userFolder, action: savePreset});
      if (!userFolder) menuHeading(menu, 'The host gave no user folder');
      menuItem(menu, 'Reset to Default', {action: () => {
        const index = presets.findIndex(p => p.name === 'Default' && !p.user);
        if (index >= 0) send({type: 'preset', index: presets[index].index});
      }});
    });
  }

  function stepPreset(direction) {
    if (!presets.length) return;
    const position = presets.findIndex(p => p.index === preset.index);
    const next = presets[(Math.max(0, position) + direction + presets.length) % presets.length];
    send({type: 'preset', index: next.index});
  }

  function setPreset(info) {
    preset = info;
    $('preset-name').textContent = (info.name || 'Init') + (info.dirty ? '*' : '');
  }

  function savePreset() {
    const dialog = $('dialog'), input = $('dialog-input');
    dialog.hidden = false;
    input.value = preset.name && !presets.some(p => !p.user && p.name === preset.name) ? preset.name : '';
    input.focus();
    const close = () => { dialog.hidden = true; input.onkeydown = null; };
    const save = () => {
      const name = input.value.trim();
      if (name) send({type: 'savePreset', name});
      close();
    };
    $('dialog-cancel').onclick = close;
    $('dialog-save').onclick = save;
    input.onkeydown = event => {
      if (event.key === 'Enter') save();
      else if (event.key === 'Escape') close();
    };
  }

  let messageTimer = 0;
  function showMessage(text) {
    const box = $('message');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { box.hidden = true; }, 4000);
  }

  // ---- header ----------------------------------------------------------------
  let hostName = '', version = '';
  function setStatus(status) {
    const rate = status.sampleRate ? `${Math.round(status.sampleRate / 100) / 10} kHz` : 'not active';
    $('info').innerHTML = '';
    $('info').title = `${hostName || 'WCLAP host'}: ${rate}, ${status.processing ? 'processing' : 'not processing'}, latency ${status.latency} samples`;
    const text = document.createElement('span');
    text.textContent = `WCLAP, v${version} ~ DSP by `;
    const by = document.createElement('b');
    by.textContent = 'chowdsp';
    $('info').append(text, by);
    if (!status.processing) drawMeters(null);
  }

  const decibels = rms => {
    const level = Math.max(rms[0] ?? 0, rms[1] ?? 0);
    return level > 1e-5 ? `${(20 * Math.log10(level)).toFixed(1)} dB` : '-inf dB';
  };

  function drawMeters(meters) {
    const canvas = $('scope');
    const ratio = window.devicePixelRatio * currentScale || 1;
    const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, width, height);
    $('level-in').textContent = `IN: ${meters ? decibels(meters.input) : '-inf dB'}`;
    $('level-out').textContent = `OUT: ${meters ? decibels(meters.output) : '-inf dB'}`;
    const samples = meters?.scope;
    if (!samples?.length) return;
    g.strokeStyle = '#eaa92c';
    g.lineWidth = 2 * ratio;
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < samples.length; ++i) {
      const x = i / (samples.length - 1) * width;
      const y = height / 2 - Math.max(-1, Math.min(1, samples[i])) * height * 0.45;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }

  // ---- sizing ------------------------------------------------------------------
  let currentScale = 1;
  function fit() {
    const width = window.innerWidth, height = window.innerHeight;
    currentScale = Math.min(width / 720, height / 620) || 1;
    editor.style.transform = `scale(${currentScale})`;
  }
  window.addEventListener('resize', fit);

  // ---- start ------------------------------------------------------------------
  function init(message) {
    initialised = true;
    clearTimeout(helloTimer);
    params.clear();
    byId.clear();
    for (const info of message.params) {
      params.set(info.key, {info: {...info, id: info.id >>> 0}, value: info.value, text: info.text, views: new Set()});
      byId.set(info.id >>> 0, info.key);
    }
    presets = message.presets;
    userFolder = !!message.userFolder;
    hostName = message.host || '';
    version = message.plugin?.version || '';
    buildPanels();
    buildBar();
    setPreset(message.preset);
    setStatus(message.status);
    editor.setAttribute('aria-busy', 'false');
    document.dispatchEvent(new CustomEvent('chowtape-ready'));
  }

  fit();
  hello();
})();
