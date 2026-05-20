/*
 * radar.js — static radar renderer.
 * Draws concentric rings, crosshair, and a subtle neon styling on canvas.
 * No animation, no data — pure foundation layer.
 */

(function () {
  "use strict";

  const RING_COUNT = 6;
  const COLOR_NEON = "#39ff9c";
  const COLOR_CYAN = "#4de2ff";
  const COLOR_RING = "rgba(57, 255, 156, 0.35)";
  const COLOR_RING_FAINT = "rgba(57, 255, 156, 0.15)";
  const COLOR_CROSS = "rgba(77, 226, 255, 0.25)";
  const COLOR_GLOW = "rgba(57, 255, 156, 0.55)";
  const COLOR_BG_RADIAL_INNER = "rgba(57, 255, 156, 0.06)";
  const COLOR_BG_RADIAL_OUTER = "rgba(5, 7, 10, 0)";

  const Radar = {
    canvas: null,
    ctx: null,
    dpr: 1,
    width: 0,
    height: 0,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.resize();
      window.addEventListener("resize", () => this.resize());
      window.addEventListener("orientationchange", () => this.resize());
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
      this.render();
    },

    render() {
      const ctx = this.ctx;
      if (!ctx) return;

      const w = this.width;
      const h = this.height;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.46;

      ctx.clearRect(0, 0, w, h);

      this._drawBackdrop(ctx, cx, cy, radius);
      this._drawRings(ctx, cx, cy, radius);
      this._drawCrosshair(ctx, cx, cy, radius);
      this._drawTicks(ctx, cx, cy, radius);
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
