/*
 * radar.js — static radar renderer with rotating sweep.
 * Step 1: concentric rings, crosshair, ticks, neon styling.
 * Step 2: clockwise sweep line with bright leading edge and fading trail.
 */

(function () {
  "use strict";

  const RING_COUNT = 6;
  const COLOR_NEON = "#39ff9c";
  const COLOR_RING = "rgba(57, 255, 156, 0.35)";
  const COLOR_RING_FAINT = "rgba(57, 255, 156, 0.15)";
  const COLOR_CROSS = "rgba(77, 226, 255, 0.25)";
  const COLOR_GLOW = "rgba(57, 255, 156, 0.55)";
  const COLOR_BG_RADIAL_INNER = "rgba(57, 255, 156, 0.06)";
  const COLOR_BG_RADIAL_OUTER = "rgba(5, 7, 10, 0)";

  // Sweep configuration
  const SWEEP_PERIOD_MS = 7000; // full rotation
  const SWEEP_TRAIL_RAD = (Math.PI * 2) * (110 / 360); // 110° trailing glow
  const SWEEP_SEGMENTS = 28; // resolution of trailing gradient

  const Radar = {
    canvas: null,
    ctx: null,
    dpr: 1,
    width: 0,
    height: 0,
    cx: 0,
    cy: 0,
    radius: 0,

    // animation
    _rafId: 0,
    _startTs: 0,
    _angle: -Math.PI / 2, // start at 12 o'clock

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.resize();
      window.addEventListener("resize", () => this.resize());
      window.addEventListener("orientationchange", () => this.resize());
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          this._stop();
        } else {
          this._start();
        }
      });
      this._start();
    },

    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.width = Math.max(1, Math.floor(rect.width));
      this.height = Math.max(1, Math.floor(rect.height));
      this.canvas.width = this.width * this.dpr;
      this.canvas.height = this.height * this.dpr;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.cx = this.width / 2;
      this.cy = this.height / 2;
      this.radius = Math.min(this.width, this.height) * 0.46;
    },

    _start() {
      if (this._rafId) return;
      const loop = (ts) => {
        if (!this._startTs) this._startTs = ts;
        const elapsed = ts - this._startTs;
        const t = (elapsed % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS;
        this._angle = -Math.PI / 2 + t * Math.PI * 2;
        this.render();
        this._rafId = requestAnimationFrame(loop);
      };
      this._rafId = requestAnimationFrame(loop);
    },

    _stop() {
      if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = 0;
      }
      this._startTs = 0;
    },

    render() {
      const ctx = this.ctx;
      if (!ctx) return;

      const { width: w, height: h, cx, cy, radius } = this;

      ctx.clearRect(0, 0, w, h);

      this._drawBackdrop(ctx, cx, cy, radius);
      this._drawRings(ctx, cx, cy, radius);
      this._drawCrosshair(ctx, cx, cy, radius);
      this._drawTicks(ctx, cx, cy, radius);
      this._drawSweep(ctx, cx, cy, radius, this._angle);
      this._drawCenter(ctx, cx, cy);
      this._drawFrame(ctx, cx, cy, radius);
    },

    _drawBackdrop(ctx, cx, cy, radius) {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.05);
      grad.addColorStop(0, COLOR_BG_RADIAL_INNER);
      grad.addColorStop(1, COLOR_BG_RADIAL_OUTER);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.05, 0, Math.PI * 2);
      ctx.fill();
    },

    _drawRings(ctx, cx, cy, radius) {
      ctx.save();
      ctx.lineWidth = 1;
      for (let i = 1; i <= RING_COUNT; i++) {
        const r = (radius * i) / RING_COUNT;
        ctx.strokeStyle = i === RING_COUNT ? COLOR_RING : COLOR_RING_FAINT;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },

    _drawCrosshair(ctx, cx, cy, radius) {
      ctx.save();
      ctx.strokeStyle = COLOR_CROSS;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    },

    _drawTicks(ctx, cx, cy, radius) {
      ctx.save();
      ctx.strokeStyle = "rgba(57, 255, 156, 0.25)";
      ctx.lineWidth = 1;
      const tickCount = 36;
      for (let i = 0; i < tickCount; i++) {
        const angle = (i / tickCount) * Math.PI * 2;
        const isMajor = i % 9 === 0;
        const inner = radius * (isMajor ? 0.94 : 0.97);
        const outer = radius;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
        ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
        ctx.stroke();
      }
      ctx.restore();
    },

    _drawSweep(ctx, cx, cy, radius, angle) {
      ctx.save();

      // Clip to radar circle so the sweep never bleeds out.
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();

      // Fading trailing wedge — built from thin radial slices so opacity
      // falls off exponentially behind the leading edge.
      const segments = SWEEP_SEGMENTS;
      const trail = SWEEP_TRAIL_RAD;
      const step = trail / segments;

      for (let i = 0; i < segments; i++) {
        const t = i / segments; // 0 at leading edge, 1 at trail tail
        const a1 = angle - i * step;
        const a0 = a1 - step;
        const alpha = Math.pow(1 - t, 2.2) * 0.32;
        if (alpha < 0.003) continue;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, a0, a1);
        ctx.closePath();
        ctx.fillStyle = `rgba(57, 255, 156, ${alpha.toFixed(4)})`;
        ctx.fill();
      }

      // Bright leading edge line.
      const ex = cx + Math.cos(angle) * radius;
      const ey = cy + Math.sin(angle) * radius;

      const lineGrad = ctx.createLinearGradient(cx, cy, ex, ey);
      lineGrad.addColorStop(0, "rgba(57, 255, 156, 0.95)");
      lineGrad.addColorStop(0.6, "rgba(57, 255, 156, 0.75)");
      lineGrad.addColorStop(1, "rgba(57, 255, 156, 0.15)");

      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = COLOR_GLOW;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      // Tiny bright tip dot at the perimeter for extra punch.
      ctx.shadowBlur = 14;
      ctx.fillStyle = COLOR_NEON;
      ctx.beginPath();
      ctx.arc(ex, ey, 2.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    },

    _drawCenter(ctx, cx, cy) {
      ctx.save();
      ctx.fillStyle = COLOR_NEON;
      ctx.shadowColor = COLOR_GLOW;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },

    _drawFrame(ctx, cx, cy, radius) {
      ctx.save();
      ctx.strokeStyle = COLOR_NEON;
      ctx.shadowColor = COLOR_GLOW;
      ctx.shadowBlur = 6;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    },
  };

  window.Radar = Radar;
})();
