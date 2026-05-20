/*
 * server.js — mock telemetry backend for the WiFi Activity Radar.
 *
 * Streams anonymous environmental activity over a WebSocket. The
 * simulation has no identity, no positions of individuals, and no
 * per-device tracking — only 8 abstract "zones" (radar sectors) whose
 * activity levels drift, occasionally spike, and occasionally go idle.
 *
 * Payload (sent every 100–300ms):
 * {
 *   "timestamp": <ms since epoch>,
 *   "global_intensity": 0.0 - 1.0,
 *   "activity_level": "none" | "low" | "medium" | "high",
 *   "zones": [{ "sector": 0..7, "activity": 0.0 - 1.0 }, ...]
 * }
 */

"use strict";

const { WebSocketServer } = require("ws");

// ---------- Configuration ----------

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const NUM_SECTORS = 8;
const TICK_MIN_MS = 100;
const TICK_MAX_MS = 300;

// Smoothing factor for sector activity (0..1). Lower = smoother / slower.
const SECTOR_SMOOTHING = 0.18;

// Activity-level thresholds (against global_intensity).
const LEVEL_THRESHOLDS = [
  { max: 0.1, label: "none" },
  { max: 0.35, label: "low" },
  { max: 0.65, label: "medium" },
  { max: Infinity, label: "high" },
];

// ---------- Simulation state ----------

const state = {
  sectors: Array.from({ length: NUM_SECTORS }, () => ({
    activity: 0.04 + Math.random() * 0.08,
    drift: (Math.random() - 0.5) * 0.1,
  })),
  mode: "normal", // "normal" | "spike" | "idle"
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
  // eslint-disable-next-line no-console
  console.log(
    `[sim] mode=${mode} for ${(durationMs / 1000).toFixed(1)}s` +
      (mode === "spike"
        ? ` (sector=${state.spikeSector}, strength=${state.spikeStrength.toFixed(2)})`
        : "")
  );
}

function maybeTransitionMode(nowMs) {
  if (nowMs < state.modeEndsAt) return;
  if (state.mode === "spike" || state.mode === "idle") {
    setMode("normal", 4000 + Math.random() * 6000);
    return;
  }
  // From normal, weighted random transition.
  const r = Math.random();
  if (r < 0.18) setMode("idle", 3000 + Math.random() * 4000);
  else if (r < 0.45) setMode("spike", 1500 + Math.random() * 2500);
  else setMode("normal", 3000 + Math.random() * 5000);
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

  // Per-sector random walk toward a slowly drifting target.
  for (let i = 0; i < NUM_SECTORS; i++) {
    const s = state.sectors[i];
    s.drift = clamp(s.drift + (Math.random() - 0.5) * 0.08, -0.22, 0.35);
    let target = baseline + s.drift;
    if (i === state.spikeSector) target += state.spikeStrength;
    target = clamp(target + (Math.random() - 0.5) * 0.04, 0, 1);
    s.activity = s.activity + (target - s.activity) * SECTOR_SMOOTHING;
  }

  // Global intensity = mean sector activity, with a small breath of noise.
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

function levelFromIntensity(v) {
  for (const t of LEVEL_THRESHOLDS) {
    if (v < t.max) return t.label;
  }
  return "high";
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

// ---------- WebSocket server ----------

const wss = new WebSocketServer({ port: PORT, host: HOST });

wss.on("listening", () => {
  // eslint-disable-next-line no-console
  console.log(`[ws] radar telemetry listening on ws://${HOST}:${PORT}`);
});

wss.on("connection", (sock, req) => {
  const ip = req.socket.remoteAddress;
  // eslint-disable-next-line no-console
  console.log(`[+] client connected (${ip}) — total=${wss.clients.size}`);

  // Send an immediate snapshot so the client doesn't have to wait for
  // the next scheduled tick to see something.
  try {
    sock.send(JSON.stringify(step()));
  } catch (_) {
    /* ignore */
  }

  sock.on("close", () => {
    // eslint-disable-next-line no-console
    console.log(`[-] client disconnected — total=${wss.clients.size}`);
  });
  sock.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[ws] socket error:", err.message);
  });
});

wss.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[ws] server error:", err.message);
});

// ---------- Broadcast loop ----------

let tickTimer = null;
function tick() {
  const payload = JSON.stringify(step());
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try {
        client.send(payload);
      } catch (_) {
        /* ignore individual send errors */
      }
    }
  }
  tickTimer = setTimeout(tick, jitter(TICK_MIN_MS, TICK_MAX_MS));
}

tick();

// ---------- Graceful shutdown ----------

function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n[ws] received ${signal}, shutting down...`);
  if (tickTimer) clearTimeout(tickTimer);
  for (const client of wss.clients) {
    try {
      client.close(1001, "server shutdown");
    } catch (_) {
      /* ignore */
    }
  }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
