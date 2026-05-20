/*
 * simulator.js — client-side telemetry generator for WiFi Activity Radar.
 *
 * Runs the same simulation as server/server.js, but directly in the browser
 * so the app works without any backend. Dispatches 'radar:data' events on
 * window that radar.js consumes.
 *
 * Payload format (matches the WebSocket protocol):
 * {
 *   timestamp: <ms since epoch>,
 *   global_intensity: 0.0 - 1.0,
 *   activity_level: "none" | "low" | "medium" | "high",
 *   zones: [{ sector: 0..7, activity: 0.0 - 1.0 }, ...]
 * }
 */

(function () {
  "use strict";

  const NUM_SECTORS = 8;
  const TICK_MIN_MS = 100;
  const TICK_MAX_MS = 300;
  const SECTOR_SMOOTHING = 0.18;

  const LEVEL_THRESHOLDS = [
    { max: 0.1, label: "none" },
    { max: 0.35, label: "low" },
    { max: 0.65, label: "medium" },
    { max: Infinity, label: "high" },
  ];

  const state = {
    sectors: Array.from({ length: NUM_SECTORS }, () => ({
      activity: 0.04 + Math.random() * 0.08,
      drift: (Math.random() - 0.5) * 0.1,
    })),
    mode: "normal",
    modeEndsAt: 0,
    spikeSector: -1,
    spikeStrength: 0,
  };

  function setMode(mode, durationMs) {
    state.mode = mode;
    state.modeEndsAt = Date.now() + durationMs;
    if (mode === "spike") {
      state.spikeSector = Math.floor(Math.random() * NUM_SECTORS);
      state.spikeStrength = 0.5 + Math.random() * 0.4;
    } else {
      state.spikeSector = -1;
      state.spikeStrength = 0;
    }
  }

  function maybeTransitionMode(nowMs) {
    if (nowMs < state.modeEndsAt) return;
    if (state.mode === "spike" || state.mode === "idle") {
      setMode("normal", 4000 + Math.random() * 6000);
      return;
    }
    const r = Math.random();
    if (r < 0.18) setMode("idle", 3000 + Math.random() * 4000);
    else if (r < 0.45) setMode("spike", 1500 + Math.random() * 2500);
    else setMode("normal", 3000 + Math.random() * 5000);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  function jitter(min, max) {
    return min + Math.random() * (max - min);
  }

  function levelFromIntensity(v) {
    for (const t of LEVEL_THRESHOLDS) {
      if (v < t.max) return t.label;
    }
    return "high";
  }

  function step() {
    const now = Date.now();
    maybeTransitionMode(now);

    let baseline;
    switch (state.mode) {
      case "idle":
        baseline = 0.03;
        break;
      case "spike":
        baseline = 0.22;
        break;
      default:
        baseline = 0.18;
        break;
    }

    for (let i = 0; i < NUM_SECTORS; i++) {
      const s = state.sectors[i];
      s.drift = clamp(s.drift + (Math.random() - 0.5) * 0.08, -0.22, 0.35);
      let target = baseline + s.drift;
      if (i === state.spikeSector) target += state.spikeStrength;
      target = clamp(target + (Math.random() - 0.5) * 0.04, 0, 1);
      s.activity = s.activity + (target - s.activity) * SECTOR_SMOOTHING;
    }

    let sum = 0;
    for (let i = 0; i < NUM_SECTORS; i++) sum += state.sectors[i].activity;
    const mean = sum / NUM_SECTORS;
    const global = clamp(mean + (Math.random() - 0.5) * 0.015, 0, 1);

    const zones = new Array(NUM_SECTORS);
    for (let i = 0; i < NUM_SECTORS; i++) {
      zones[i] = { sector: i, activity: round3(state.sectors[i].activity) };
    }

    return {
      timestamp: now,
      global_intensity: round3(global),
      activity_level: levelFromIntensity(global),
      zones,
    };
  }

  let tickTimer = null;
  let running = false;

  function tick() {
    if (!running) return;
    const payload = step();

    if (window.RadarState) {
      window.RadarState.connected = true;
      window.RadarState.lastMessageAt = Date.now();
      window.RadarState.data = payload;
    }

    try {
      window.dispatchEvent(new CustomEvent("radar:data", { detail: payload }));
    } catch (_) {
      /* ignore */
    }

    tickTimer = setTimeout(tick, jitter(TICK_MIN_MS, TICK_MAX_MS));
  }

  const Simulator = {
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      if (tickTimer) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
    },
    isRunning() {
      return running;
    },
  };

  window.RadarSimulator = Simulator;
})();
