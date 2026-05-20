/*
 * app.js — bootstrap for WiFi Activity Radar.
 *
 * Step 1: mounts the static radar canvas.
 * Step 2: kicks off the sweep animation (handled inside radar.js).
 * Step 3: opens a WebSocket to the backend and keeps the latest
 *         payload available on window.RadarState. No rendering of
 *         live data yet — that wiring lands in a later step.
 */

(function () {
  "use strict";

  // ---------- Configuration ----------

  // Default WS URL is derived from the page location. Override by setting
  //   window.RADAR_WS_URL = "ws://host:port/path"
  // before this script runs, or by adding ?ws=ws://... to the page URL.
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

  // ---------- Shared state ----------

  /**
   * RadarState is the single source of truth for backend data.
   * radar.js (and anything else) will read from here later.
   */
  const RadarState = {
    connected: false,
    lastMessageAt: 0,
    lastError: null,

    // Latest payload, shape matches backend contract.
    data: {
      blips: [],
      global_intensity: 0.0,
      activity_level: "low",
    },
  };
  window.RadarState = RadarState;

  // ---------- HUD status indicator ----------

  function setStatus(text) {
    const el = document.getElementById("status-tag");
    if (el) el.textContent = text;
  }

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
        this._scheduleReconnect();
        return;
      }
      this.socket = sock;
      setStatus("CONNECTING");

      sock.addEventListener("open", () => {
        RadarState.connected = true;
        RadarState.lastError = null;
        this.reconnectDelay = RECONNECT_MIN_MS;
        setStatus("LIVE");
      });

      sock.addEventListener("message", (evt) => {
        this._handleMessage(evt.data);
      });

      sock.addEventListener("close", () => {
        RadarState.connected = false;
        this.socket = null;
        if (!this.manualClose) {
          setStatus("RECONNECT");
          this._scheduleReconnect();
        } else {
          setStatus("OFFLINE");
        }
      });

      sock.addEventListener("error", (evt) => {
        RadarState.lastError = "socket error";
        // The browser will fire 'close' right after — reconnect is handled there.
      });
    },

    _handleMessage(raw) {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (_) {
        return; // ignore non-JSON frames
      }
      if (!payload || typeof payload !== "object") return;

      const next = RadarState.data;
      if (Array.isArray(payload.blips)) next.blips = payload.blips;
      if (typeof payload.global_intensity === "number") {
        next.global_intensity = payload.global_intensity;
      }
      if (typeof payload.activity_level === "string") {
        next.activity_level = payload.activity_level;
      }

      RadarState.lastMessageAt = Date.now();

      // Dispatch a lightweight event so future consumers (radar.js, HUD)
      // can subscribe without polling.
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

  // ---------- Boot ----------

  function boot() {
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
