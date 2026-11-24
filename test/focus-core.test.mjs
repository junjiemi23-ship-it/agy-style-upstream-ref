import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const focusCore = require('../focus-core.js');

test('sprint timer lifecycle: start, pause, resume, completion celebration, and reset', () => {
  const timer = focusCore.createSprintTimer(25);
  const t0 = 1_000_000;
  let snap = timer.getSnapshot(t0);
  assert.equal(snap.status, 'idle');
  assert.equal(snap.formatted, '25:00');
  assert.equal(snap.progress, 0);

  snap = timer.start(25, t0);
  assert.equal(snap.status, 'running');
  assert.equal(snap.remainingMs, 25 * 60 * 1000);

  const tHalf = t0 + 10 * 60 * 1000;
  const tickMid = timer.tick(tHalf);
  assert.equal(tickMid.justCompleted, false);
  assert.equal(tickMid.formatted, '15:00');
  assert.ok(tickMid.progress > 0.39 && tickMid.progress < 0.41);

  snap = timer.pause(tHalf);
  assert.equal(snap.status, 'paused');
  assert.equal(snap.formatted, '15:00');

  // Time advances while paused: remainingMs must stay frozen
  assert.equal(timer.getSnapshot(tHalf + 60_000).formatted, '15:00');

  snap = timer.resume(tHalf + 60_000);
  assert.equal(snap.status, 'running');

  const tickDone = timer.tick(tHalf + 60_000 + 15 * 60 * 1000 + 100);
  assert.equal(tickDone.justCompleted, true);
  assert.equal(tickDone.status, 'completed');
  assert.equal(tickDone.formatted, '00:00');
  assert.equal(tickDone.completedCount, 1);

  // Subsequent tick does not re-fire justCompleted
  assert.equal(timer.tick(tHalf + 60_000 + 16 * 60 * 1000).justCompleted, false);

  const resetSnap = timer.reset(tHalf + 70_000);
  assert.equal(resetSnap.status, 'idle');
  assert.equal(resetSnap.formatted, '25:00');
});

test('meteor trajectory smoothly transitions entry -> cruise (riding) -> landing back at anchor', () => {
  const start = focusCore.sampleMeteorTrajectory(0, { spanX: 300, liftY: 64 });
  assert.equal(start.phase, 'entry');
  assert.equal(start.riding, false);
  assert.equal(start.crabDx, 0);
  assert.equal(start.crabDy, 0);
  assert.ok(start.meteorDx < -150);

  const mid = focusCore.sampleMeteorTrajectory(0.51, { spanX: 300, liftY: 64 });
  assert.equal(mid.phase, 'cruise');
  assert.equal(mid.riding, true);
  assert.ok(mid.crabDx < -200, 'Clawd sweeps across the composer top edge');
  assert.ok(mid.crabDy < -40, 'Clawd lifts upward along starlight arc');
  assert.equal(mid.meteorOpacity, 1);

  const end = focusCore.sampleMeteorTrajectory(1, { spanX: 300, liftY: 64 });
  assert.equal(end.phase, 'landing');
  assert.equal(end.riding, false);
  assert.equal(end.crabDx, 0);
  assert.equal(end.crabDy, 0);
  assert.equal(end.meteorOpacity, 0);
});

test('meteor wish and auto-launch guard strictly suppresses distractions during focus mode or typing', () => {
  const now = 500_000;
  assert.equal(
    focusCore.shouldAutoLaunchMeteor({
      meteorMode: 'auto',
      focusMode: true,
      mascot: 'crab',
      now,
      lastTypingAt: 0,
      nextAutoAt: now - 1000,
    }),
    false,
    'Focus mode must block auto meteor flights'
  );

  assert.equal(
    focusCore.shouldAutoLaunchMeteor({
      meteorMode: 'auto',
      focusMode: false,
      mascot: 'crab',
      now,
      lastTypingAt: now - 5000,
      nextAutoAt: now - 1000,
    }),
    false,
    'Active typing within 45s must block auto meteor flights'
  );

  assert.equal(
    focusCore.shouldAutoLaunchMeteor({
      meteorMode: 'auto',
      focusMode: false,
      mascot: 'crab',
      now,
      lastTypingAt: now - 60_000,
      nextAutoAt: now - 1000,
    }),
    true
  );

  const flight = focusCore.createMeteorFlight({ now, kind: 'celebration' });
  assert.equal(flight.durationMs, focusCore.CELEBRATION_FLIGHT_MS);
  assert.equal(focusCore.triggerMeteorWish(flight, now + 500), true);
  assert.equal(flight.wished, true);
  assert.equal(focusCore.triggerMeteorWish(flight, now + 900), false);
});

test('matchFocusHotkey recognizes Alt+Shift+F/P/M/T cleanly', () => {
  assert.equal(focusCore.matchFocusHotkey({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: 'KeyF', key: 'F' }), 'toggle-focus');
  assert.equal(focusCore.matchFocusHotkey({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: 'KeyP', key: 'P' }), 'toggle-sprint');
  assert.equal(focusCore.matchFocusHotkey({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: 'KeyM', key: 'M' }), 'launch-meteor');
  assert.equal(focusCore.matchFocusHotkey({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: 'KeyT', key: 'T' }), 'toggle-hud');
  assert.equal(focusCore.matchFocusHotkey({ altKey: false, shiftKey: true, ctrlKey: true, metaKey: false, code: 'KeyF', key: 'F' }), null);
});
