/*
 * app.js — bootstrap for WiFi Activity Radar.
 * Wires up the static radar canvas on load. No data wiring yet.
 */

(function () {
  "use strict";

  function boot() {
    const canvas = document.getElementById("radar-canvas");
    if (!canvas || !window.Radar) return;
    window.Radar.init(canvas);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
