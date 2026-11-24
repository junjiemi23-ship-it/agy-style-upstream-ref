(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.__agCsFocusCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const SPRINT_OPTIONS = ['off', '25', '45'];
  const METEOR_OPTIONS = ['auto', 'manual', 'off'];
  const DEFAULT_FLIGHT_MS = 5600;
  const CELEBRATION_FLIGHT_MS = 6800;
  const AUTO_IDLE_QUIET_MS = 45000;
  const AUTO_COOLDOWN_MIN_MS = 180000;
  const AUTO_COOLDOWN_SPAN_MS = 120000;

  function normalizeSprintMinutes(val) {
    const s = String(val ?? '25').trim();
    return SPRINT_OPTIONS.includes(s) ? s : '25';
  }

  function normalizeMeteorMode(val) {
    const s = String(val ?? 'auto').trim();
    return METEOR_OPTIONS.includes(s) ? s : 'auto';
  }

  function formatClock(ms) {
    const clamped = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    const mins = Math.floor(clamped / 60);
    const secs = clamped % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function createSprintTimer(initialMinutes = 25) {
    let durationMin = Math.max(1, parseInt(initialMinutes, 10) || 25);
    let status = 'idle'; // 'idle' | 'running' | 'paused' | 'completed'
    let remainingMs = durationMin * 60 * 1000;
    let endAt = 0;
    let completedCount = 0;

    function syncRemaining(now) {
      if (status === 'running') {
        remainingMs = Math.max(0, endAt - now);
        if (remainingMs <= 0) {
          status = 'completed';
          endAt = 0;
          completedCount += 1;
          return true;
        }
      }
      return false;
    }

    return {
      setDurationMinutes(mins, now = Date.now()) {
        const parsed = parseInt(mins, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) return this.getSnapshot(now);
        durationMin = parsed;
        if (status === 'idle' || status === 'completed') {
          status = 'idle';
          remainingMs = durationMin * 60 * 1000;
        }
        return this.getSnapshot(now);
      },
      start(mins = durationMin, now = Date.now()) {
        const parsed = parseInt(mins, 10);
        if (Number.isFinite(parsed) && parsed > 0) durationMin = parsed;
        remainingMs = durationMin * 60 * 1000;
        endAt = now + remainingMs;
        status = 'running';
        return this.getSnapshot(now);
      },
      pause(now = Date.now()) {
        syncRemaining(now);
        if (status === 'running') {
          status = 'paused';
          endAt = 0;
        }
        return this.getSnapshot(now);
      },
      resume(now = Date.now()) {
        if (status === 'paused' && remainingMs > 0) {
          endAt = now + remainingMs;
          status = 'running';
        }
        return this.getSnapshot(now);
      },
      toggle(defaultMins = durationMin, now = Date.now()) {
        syncRemaining(now);
        if (status === 'running') return this.pause(now);
        if (status === 'paused' && remainingMs > 0) return this.resume(now);
        return this.start(defaultMins, now);
      },
      reset(now = Date.now()) {
        status = 'idle';
        endAt = 0;
        remainingMs = durationMin * 60 * 1000;
        return this.getSnapshot(now);
      },
      tick(now = Date.now()) {
        const justCompleted = syncRemaining(now);
        return {
          ...this.getSnapshot(now),
          justCompleted,
        };
      },
      getSnapshot(now = Date.now()) {
        const curRem = status === 'running' ? Math.max(0, endAt - now) : remainingMs;
        const totalMs = durationMin * 60 * 1000;
        const progress = totalMs > 0 ? Math.max(0, Math.min(1, 1 - curRem / totalMs)) : 0;
        return {
          status,
          durationMin,
          remainingMs: curRem,
          formatted: formatClock(curRem),
          progress,
          completedCount,
        };
      },
    };
  }

  function smoothstep(edge0, edge1, x) {
    if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // Compute smooth 3-phase starlight trajectory relative to Clawd's home anchor (top-right of composer).
  // Coordinates: dx <= 0 moves left across the composer top edge; dy <= 0 lifts upward into the sky.
  function sampleMeteorTrajectory(progress, opts = {}) {
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    const spanX = Math.max(140, Math.min(560, Number(opts.spanX) || 300));
    const liftY = Math.max(36, Math.min(140, Number(opts.liftY) || 64));

    const entryEnd = 0.18;
    const cruiseEnd = 0.84;

    let meteorDx = 0;
    let meteorDy = 0;
    let crabDx = 0;
    let crabDy = 0;
    let riding = false;
    let meteorOpacity = 1;
    let phase = 'entry';

    const pointAt = (t) => {
      if (t <= entryEnd) {
        const u = smoothstep(0, entryEnd, t);
        return {
          mx: -spanX * 0.68 * (1 - u),
          my: -liftY * 0.95 * (1 - u),
          cx: 0,
          cy: 0,
        };
      }
      if (t <= cruiseEnd) {
        const u = (t - entryEnd) / (cruiseEnd - entryEnd);
        // Closed loop starting at (0,0), sweeping left across composer, cresting, and returning to (0,0).
        const theta = u * Math.PI * 2;
        const mx = -spanX * 0.5 * (1 - Math.cos(theta));
        const arch = Math.sin(u * Math.PI);
        const wave = Math.sin(u * Math.PI * 3) * 0.16;
        const my = -liftY * (arch * 0.88 + wave * arch);
        return {
          mx,
          my,
          cx: mx,
          cy: my - 8,
        };
      }
      const u = smoothstep(cruiseEnd, 1, t);
      return {
        mx: spanX * 0.28 * u,
        my: -liftY * 0.55 * u,
        cx: 0,
        cy: -8 * (1 - u),
      };
    };

    const cur = pointAt(p);
    const ahead = pointAt(Math.min(1, p + 0.015));
    meteorDx = cur.mx;
    meteorDy = cur.my;
    crabDx = cur.cx;
    crabDy = cur.cy;

    if (p <= entryEnd) {
      phase = 'entry';
      meteorOpacity = smoothstep(0, 0.07, p);
    } else if (p <= cruiseEnd) {
      phase = 'cruise';
      riding = true;
      meteorOpacity = 1;
    } else {
      phase = 'landing';
      riding = false;
      meteorOpacity = 1 - smoothstep(cruiseEnd, 1, p);
    }

    const vx = ahead.mx - cur.mx;
    const vy = ahead.my - cur.my;
    const angleDeg = Math.hypot(vx, vy) > 0.01 ? (Math.atan2(vy, vx) * 180) / Math.PI : -12;

    return {
      phase,
      riding,
      progress: p,
      meteorDx: Number(meteorDx.toFixed(2)),
      meteorDy: Number(meteorDy.toFixed(2)),
      crabDx: Number(crabDx.toFixed(2)),
      crabDy: Number(crabDy.toFixed(2)),
      angleDeg: Number(angleDeg.toFixed(1)),
      meteorOpacity: Number(meteorOpacity.toFixed(3)),
    };
  }

  function createMeteorFlight({ now = Date.now(), kind = 'cruise', spanX = 300, liftY = 64 } = {}) {
    const normalizedKind = kind === 'celebration' ? 'celebration' : 'cruise';
    const durationMs = normalizedKind === 'celebration' ? CELEBRATION_FLIGHT_MS : DEFAULT_FLIGHT_MS;
    return {
      kind: normalizedKind,
      startedAt: now,
      durationMs,
      spanX,
      liftY,
      wished: false,
      wishAt: 0,
    };
  }

  function triggerMeteorWish(flight, now = Date.now()) {
    if (!flight || flight.wished) return false;
    flight.wished = true;
    flight.wishAt = now;
    return true;
  }

  function computeNextMeteorCooldownMs(randomFn = Math.random) {
    const r = Math.max(0, Math.min(1, Number(randomFn()) || 0));
    return Math.round(AUTO_COOLDOWN_MIN_MS + r * AUTO_COOLDOWN_SPAN_MS);
  }

  function shouldAutoLaunchMeteor({
    meteorMode = 'auto',
    focusMode = false,
    mascot = 'crab',
    isFlightActive = false,
    hasError = false,
    now = Date.now(),
    lastTypingAt = 0,
    nextAutoAt = 0,
  } = {}) {
    if (normalizeMeteorMode(meteorMode) !== 'auto') return false;
    if (focusMode || mascot !== 'crab' || isFlightActive || hasError) return false;
    if (nextAutoAt <= 0 || now < nextAutoAt) return false;
    if (lastTypingAt > 0 && now - lastTypingAt < AUTO_IDLE_QUIET_MS) return false;
    return true;
  }

  function matchFocusHotkey(ev) {
    if (!ev || !ev.altKey || !ev.shiftKey || ev.ctrlKey || ev.metaKey) return null;
    const code = String(ev.code || '');
    const key = String(ev.key || '').toUpperCase();
    if (code === 'KeyF' || key === 'F') return 'toggle-focus';
    if (code === 'KeyP' || key === 'P') return 'toggle-sprint';
    if (code === 'KeyM' || key === 'M') return 'launch-meteor';
    if (code === 'KeyT' || key === 'T') return 'toggle-hud';
    return null;
  }

  return {
    SPRINT_OPTIONS,
    METEOR_OPTIONS,
    DEFAULT_FLIGHT_MS,
    CELEBRATION_FLIGHT_MS,
    AUTO_IDLE_QUIET_MS,
    AUTO_COOLDOWN_MIN_MS,
    AUTO_COOLDOWN_SPAN_MS,
    normalizeSprintMinutes,
    normalizeMeteorMode,
    formatClock,
    createSprintTimer,
    sampleMeteorTrajectory,
    createMeteorFlight,
    triggerMeteorWish,
    computeNextMeteorCooldownMs,
    shouldAutoLaunchMeteor,
    matchFocusHotkey,
  };
});
