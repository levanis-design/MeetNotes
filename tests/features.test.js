'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const layout = require('../src/mini-layout');
const { createStore } = require('../src/store');
test('layout: widget sits in each corner with a margin and nearest corner is detected', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = layout.SIZES.pill;
  assert.deepStrictEqual(layout.cornerPosition('top-right', size, wa), { x: 1920 - size.width - layout.MARGIN, y: layout.MARGIN });
  assert.deepStrictEqual(layout.cornerPosition('top-left', size, wa), { x: layout.MARGIN, y: layout.MARGIN });
  assert.deepStrictEqual(layout.cornerPosition('bottom-right', size, wa), { x: 1920 - size.width - layout.MARGIN, y: 1040 - size.height - layout.MARGIN });
  assert.deepStrictEqual(layout.cornerPosition('bottom-left', size, wa), { x: layout.MARGIN, y: 1040 - size.height - layout.MARGIN });
  const at = (x, y) => ({ x, y, width: size.width, height: size.height });
  assert.strictEqual(layout.nearestCorner(at(1400, 20), wa), 'top-right');
  assert.strictEqual(layout.nearestCorner(at(40, 30), wa), 'top-left');
  assert.strictEqual(layout.nearestCorner(at(1500, 900), wa), 'bottom-right');
  assert.strictEqual(layout.nearestCorner(at(100, 950), wa), 'bottom-left');
});

test('layout: respects a work area that does not start at the origin (second monitor, taskbar)', () => {
  const wa = { x: 1920, y: 40, width: 1280, height: 960 };
  const p = layout.cornerPosition('bottom-left', layout.SIZES.dot, wa);
  assert.strictEqual(p.x, 1920 + layout.MARGIN);
  assert.strictEqual(p.y, 40 + 960 - layout.SIZES.dot.height - layout.MARGIN);
  assert.ok(layout.isCorner('top-left') && !layout.isCorner('middle'));
  assert.ok(layout.isSize('dot') && !layout.isSize('huge') && !layout.isSize('__proto__'));
});

// ---------- settings ----------
const b64 = {
  encrypt: (s) => Buffer.from(s).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meetnotes-'));

test('settings: widget defaults', () => {
  const s = createStore(tmp(), b64).getSettings();
  assert.strictEqual(s.miniAppearance, 'solid');
  assert.strictEqual(s.miniCorner, 'top-right');
  assert.strictEqual(s.miniSize, 'pill');
  assert.strictEqual(s.autoMini, true);
  assert.strictEqual(s.mainAlwaysOnTop, false);
});

test('settings: values are validated and clamped', () => {
  const st = createStore(tmp(), b64);
  st.setSettings({ miniOpacity: 5, miniCorner: 'middle', miniSize: 'huge', miniAppearance: 'neon', autoMini: 'yes' });
  let s = st.getSettings();
  assert.strictEqual(s.miniOpacity, 20, 'clamped to minimum');
  assert.strictEqual(s.miniCorner, 'top-right');
  assert.strictEqual(s.miniSize, 'pill');
  assert.strictEqual(s.miniAppearance, 'solid');
  assert.strictEqual(s.autoMini, true);
  st.setSettings({ miniOpacity: 400, miniCorner: 'bottom-left', miniSize: 'card', miniAppearance: 'transparent', autoMini: false, mainAlwaysOnTop: true });
  s = st.getSettings();
  assert.deepStrictEqual(
    [s.miniOpacity, s.miniCorner, s.miniSize, s.miniAppearance, s.autoMini, s.mainAlwaysOnTop],
    [100, 'bottom-left', 'card', 'transparent', false, true],
  );
});
