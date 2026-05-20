/*
 * app.js — bootstrap for WiFi Activity Radar.
 *
 * Step 1: mounts the static radar canvas.
 * Step 2: kicks off the sweep animation (handled inside radar.js).
 * Step 3: opens a WebSocket and keeps the latest payload on window.RadarState.
 * Step 4–5: radar.js consumes the 'radar:data' event.
 * Step 6: drives the HUD (activity level, intensity bar, status chip)
 *         and the optional FPS overlay.
 */

(function () {
  "use strict";

  // ---------- Configuration ----------

  function resolveWsUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get("ws");
      if (fromQuery) return fromQuery;
    } catch (_) {
      /* ignore */
    }
    if (typeof window.RADAR_WS_URL === "string" && window.RADAR_WS_URL) {
      return window.RADAR_WS_URL;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host || "localhost:8080";
    return `${proto}//${host}/ws`;
  }

  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;

  const ACTIVITY_LEVELS = ["none", "low", "medium", "high"];

  // ---------- Shared state ----------

  const RadarState = {
    connected: false,
    lastMessageAt: 0,
    lastError: null,
    data: {
      blips: [],
      global_intensity: 0.0,
      activity_level: "none",
    },
  };
  window.RadarState = RadarState;

  // ---------- HUD ----------

  const HUD = {
    body: document.body,
    activityEl: null,
    intensityValueEl: null,
    intensityFillEl: null,
    intensityBarEl: null,
    statusEl: null,
    statusTextEl: null,

    _pendingActivity: null,
    _pendingIntensity: null,
    _rafScheduled: false,

    init() {
      this.activityEl = document.getElementById("hud-activity");
      this.intensityValueEl = document.getElementById("hud-intensity-value");
      this.intensityFillEl = document.getElementById("hud-intensity-fill");
      this.intensityBarEl = this.intensityFillEl
        ? this.intensityFillEl.parentElement
        : null;
      this.statusEl = document.getElementById("status-tag");
      this.statusTextEl = this.statusEl
        ? this.statusEl.querySelector(".status-text")
        : null;

      this._applyActivity("none");
      this._applyIntensity(0);
    },

    setStatus(state, text) {
      if (!this.statusEl) return;
      this.statusEl.classList.remove(
        "status-live",
        "status-connecting",
        "status-reconnect",
        "status-disconnected"
      );
      this.statusEl.classList.add(`status-${state}`);
      if (this.statusTextEl) this.statusTextEl.textContent = text;
    },

    setActivity(level) {
      const norm = ACTIVITY_LEVELS.indexOf(level) >= 0 ? level : "none";
      this._pendingActivity = norm;
      this._schedule();
    },

    setIntensity(value) {
      this._pendingIntensity = clamp01(value);
      this._schedule();
    },

    _schedule() {
      if (this._rafScheduled) return;
      this._rafScheduled = true;
      requestAnimationFrame(() => {
        this._rafScheduled = false;
        if (this._pendingActivity !== null) {
          this._applyActivity(this._pendingActivity);
          this._pendingActivity = null;
        }
        if (this._pendingIntensity !== null) {
          this._applyIntensity(this._pendingIntensity);
          this._pendingIntensity = null;
        }
      });
    },

    _applyActivity(norm) {
      if (this.body.getAttribute("data-activity") !== norm) {
        this.body.setAttribute("data-activity", norm);
      }
      if (this.activityEl) {
        const up = norm.toUpperCase();
        if (this.activityEl.textContent !== up) this.activityEl.textContent = up;
      }
    },

    _applyIntensity(v) {
      if (this.intensityFillEl) {
        this.intensityFillEl.style.width = `${(v * 100).toFixed(1)}%`;
      }
      if (this.intensityValueEl) {
        this.intensityValueEl.textContent = v.toFixed(2);
      }
      if (this.intensityBarEl) {
        this.intensityBarEl.setAttribute("aria-valuenow", v.toFixed(2));
      }
    },
  };

  // ---------- FPS overlay ----------

  const FPS = {
    visible: false,
    rafId: 0,
    lastTs: 0,
    frames: 0,
    accum: 0,
    valueEl: null,
    readoutEl: null,
    toggleEl: null,

    init() {
      this.valueEl = document.getElementById("fps-value");
      this.readoutEl = document.getElementById("fps-readout");
      this.toggleEl = document.getElementById("fps-toggle");
      if (this.toggleEl) {
        this.toggleEl.addEventListener("click", () => this.toggle());
      }
    },

    toggle() {
      this.visible = !this.visible;
      if (this.toggleEl) {
        this.toggleEl.setAttribute("aria-pressed", String(this.visible));
      }
      if (this.readoutEl) this.readoutEl.hidden = !this.visible;
      if (this.visible) this._start();
      else this._stop();
    },

    _start() {
      if (this.rafId) return;
      this.lastTs = 0;
      this.frames = 0;
      this.accum = 0;
      const loop = (ts) => {
        if (!this.lastTs) this.lastTs = ts;
        const dt = ts - this.lastTs;
        this.lastTs = ts;
        this.frames++;
        this.accum += dt;
        if (this.accum >= 500) {
          const fps = (this.frames * 1000) / this.accum;
          if (this.valueEl) this.valueEl.textContent = fps.toFixed(0);
          this.frames = 0;
          this.accum = 0;
        }
        this.rafId = requestAnimationFrame(loop);
      };
      this.rafId = requestAnimationFrame(loop);
    },

    _stop() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      if (this.valueEl) this.valueEl.textContent = "--";
    },
  };

  // ---------- WebSocket client ----------

  const WS = {
    url: "",
    socket: null,
    reconnectDelay: RECONNECT_MIN_MS,
    reconnectTimer: 0,
    manualClose: false,

    connect() {
      this.url = resolveWsUrl();
      this.manualClose = false;
      this._open();
    },

    _open() {
      let sock;
      try {
        sock = new WebSocket(this.url);
      } catch (err) {
        RadarState.lastError = String(err);
        HUD.setStatus("reconnect", "RECONNECT");
        this._scheduleReconnect();
        return;
      }
      this.socket = sock;
      HUD.setStatus("connecting", "CONNECTING");

      sock.addEventListener("open", () => {
        RadarState.connected = true;
        RadarState.lastError = null;
        this.reconnectDelay = RECONNECT_MIN_MS;
        HUD.setStatus("live", "LIVE");
      });

      sock.addEventListener("message", (evt) => {
        this._handleMessage(evt.data);
      });

      sock.addEventListener("close", () => {
        RadarState.connected = false;
        this.socket = null;
        if (!this.manualClose) {
          HUD.setStatus("reconnect", "RECONNECT");
          this._scheduleReconnect();
        } else {
          HUD.setStatus("disconnected", "OFFLINE");
        }
      });

      sock.addEventListener("error", () => {
        RadarState.lastError = "socket error";
      });
    },

    _handleMessage(raw) {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (!payload || typeof payload !== "object") return;

      const next = RadarState.data;
      if (Array.isArray(payload.blips)) next.blips = payload.blips;
      if (typeof payload.global_intensity === "number") {
        next.global_intensity = payload.global_intensity;
        HUD.setIntensity(payload.global_intensity);
      }
      if (typeof payload.activity_level === "string") {
        next.activity_level = payload.activity_level;
        HUD.setActivity(payload.activity_level.toLowerCase());
      }

      RadarState.lastMessageAt = Date.now();

      window.dispatchEvent(
        new CustomEvent("radar:data", { detail: RadarState.data })
      );
    },

    _scheduleReconnect() {
      if (this.reconnectTimer) return;
      const delay = this.reconnectDelay;
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = 0;
        this._open();
      }, delay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    },

    close() {
      this.manualClose = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = 0;
      }
      if (this.socket) {
        try {
          this.socket.close();
        } catch (_) {
          /* ignore */
        }
      }
    },
  };
  window.RadarWS = WS;

  // ---------- Helpers ----------

  function clamp01(n) {
    const v = typeof n === "number" ? n : Number(n);
    if (Number.isNaN(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  // ---------- Boot ----------

  function boot() {
    HUD.init();
    FPS.init();

    const canvas = document.getElementById("radar-canvas");
    if (canvas && window.Radar) {
      window.Radar.init(canvas);
    }

    WS.connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
