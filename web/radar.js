/*
 * radar.js — radar renderer with sweep + live blips.
 * Step 1: static rings, crosshair, ticks, neon framing.
 * Step 2: clockwise sweep with bright leading edge and fading trail.
 * Step 3: (no changes — data layer lives in app.js).
 * Step 4: incoming blips are drawn as glowing dots that fade smoothly.
 * Step 5: blips pulse + emit a ripple when the sweep passes over them.
 */

(function () {
  "use strict";

  // ---------- Visual constants ----------

  const RING_COUNT = 6;
  const COLOR_NEON = "#39ff9c";
  const COLOR_RING = "rgba(57, 255, 156, 0.35)";
  const COLOR_RING_FAINT = "rgba(57, 255, 156, 0.15)";
  const COLOR_CROSS = "rgba(77, 226, 255, 0.25)";
  const COLOR_GLOW = "rgba(57, 255, 156, 0.55)";
  const COLOR_BG_RADIAL_INNER = "rgba(57, 255, 156, 0.06)";
  const COLOR_BG_RADIAL_OUTER = "rgba(5, 7, 10, 0)";

  // Sweep
  const SWEEP_PERIOD_MS = 7000;
  const SWEEP_TRAIL_RAD = (Math.PI * 2) * (110 / 360);
  const SWEEP_SEGMENTS = 28;

  // Blips
  const BLIP_LIFETIME_MS = 3500;   // total visible duration
  const BLIP_FADE_IN_MS = 220;     // quick ease-in to avoid pop-in
  const BLIP_MIN_RADIUS = 3.0;     // px at intensity 0
  const BLIP_MAX_RADIUS = 9.5;     // px at intensity 1
  const BLIP_MAX_ACTIVE = 256;     // hard cap to keep mobile happy

  // Sweep-pass interaction
  const PULSE_DURATION_MS = 650;   // brightness / size pulse after a sweep hit
  const RIPPLE_DURATION_MS = 800;  // expanding ring lifetime
  const RIPPLE_EXPAND_PX = 38;     // how far the ring grows
  const RIPPLE_MAX_ACTIVE = 64;    // hard cap on concurrent ripples

  // ---------- Radar singleton ----------

  const Radar = {
    canvas: null,
    ctx: null,
    dpr: 1,
    width: 0,
    height: 0,
    cx: 0,
    cy: 0,
    radius: 0,

    _rafId: 0,
    _startTs: 0,
    _angle: -Math.PI / 2,
    _prevAngle: -Math.PI / 2,
    _blips: [],   // { x, y, intensity, bornAt, lastPingAt }
    _ripples: [], // { x, y, intensity, bornAt }

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.resize();

      window.addEventListener("resize", () => this.resize());
      window.addEventListener("orientationchange", () => this.resize());
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this._stop();
        else this._start();
      });

      // Subscribe to the WebSocket data stream from app.js.
      window.addEventListener("radar:data", (evt) => {
        this.ingest(evt.detail && evt.detail.blips);
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

    /**
     * Accept a fresh list of blips from the backend. Each entry is
     * stamped with bornAt so it can fade out independently.
     */
    ingest(blips) {
      if (!Array.isArray(blips) || blips.length === 0) return;
      const now = performance.now();
      for (const b of blips) {
        if (!b) continue;
        const x = clamp01(b.x);
        const y = clamp01(b.y);
        const intensity = clamp01(b.intensity);
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        this._blips.push({ x, y, intensity, bornAt: now, lastPingAt: 0 });
      }
      // Cap active blips, dropping the oldest first.
      if (this._blips.length > BLIP_MAX_ACTIVE) {
        this._blips.splice(0, this._blips.length - BLIP_MAX_ACTIVE);
      }
    },

    _start() {
      if (this._rafId) return;
      const loop = (ts) => {
        if (!this._startTs) this._startTs = ts;
        const elapsed = ts - this._startTs;
        const t = (elapsed % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS;
        this._prevAngle = this._angle;
        this._angle = -Math.PI / 2 + t * Math.PI * 2;
        this.render(performance.now());
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

    render(nowMs) {
      const ctx = this.ctx;
      if (!ctx) return;

      const { width: w, height: h, cx, cy, radius } = this;

      ctx.clearRect(0, 0, w, h);

      this._drawBackdrop(ctx, cx, cy, radius);
      this._drawRings(ctx, cx, cy, radius);
      this._drawCrosshair(ctx, cx, cy, radius);
      this._drawTicks(ctx, cx, cy, radius);
      this._detectSweepHits(nowMs);
      this._drawBlips(ctx, cx, cy, radius, nowMs);
      this._drawRipples(ctx, cx, cy, radius, nowMs);
      this._drawSweep(ctx, cx, cy, radius, this._angle);
      this._drawCenter(ctx, cx, cy);
      this._drawFrame(ctx, cx, cy, radius);
    },

    /**
     * Compare current vs previous sweep angle and detect blips whose
     * angle from radar centre was crossed this frame. Tags the blip
     * with lastPingAt and spawns a ripple.
     */
    _detectSweepHits(nowMs) {
      if (this._blips.length === 0) return;

      const TAU = Math.PI * 2;
      let delta = this._angle - this._prevAngle;
      // Normalize to a positive forward step. If the sweep wrapped from
      // ~2π back to 0, delta becomes negative — add TAU to keep it forward.
      delta = ((delta % TAU) + TAU) % TAU;
      if (delta <= 0) return;

      const cx = this.cx;
      const cy = this.cy;
      const radius = this.radius;
      const prev = ((this._prevAngle % TAU) + TAU) % TAU;

      for (let i = 0; i < this._blips.length; i++) {
        const b = this._blips[i];
        const px = cx + (b.x - 0.5) * 2 * radius;
        const py = cy + (b.y - 0.5) * 2 * radius;
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy > radius * radius * 1.02) continue;

        const blipAngle = Math.atan2(dy, dx);
        const rel = ((blipAngle - prev) % TAU + TAU) % TAU;
        if (rel <= delta) {
          // Debounce: don't re-ping a blip within a single sweep arc.
          if (nowMs - b.lastPingAt < PULSE_DURATION_MS * 0.6) continue;
          b.lastPingAt = nowMs;
          this._spawnRipple(b.x, b.y, b.intensity, nowMs);
        }
      }
    },

    _spawnRipple(x, y, intensity, nowMs) {
      this._ripples.push({ x, y, intensity, bornAt: nowMs });
      if (this._ripples.length > RIPPLE_MAX_ACTIVE) {
        this._ripples.splice(0, this._ripples.length - RIPPLE_MAX_ACTIVE);
      }
    },

    // ---------- Drawing primitives ----------

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

    _drawBlips(ctx, cx, cy, radius, nowMs) {
      if (this._blips.length === 0) return;

      ctx.save();
      // Clip to the radar disc so blips never escape the frame.
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();

      const alive = [];
      for (let i = 0; i < this._blips.length; i++) {
        const b = this._blips[i];
        const age = nowMs - b.bornAt;
        if (age >= BLIP_LIFETIME_MS) continue;

        // Smooth fade-in then ease-out across lifetime.
        const fadeIn = Math.min(1, age / BLIP_FADE_IN_MS);
        const lifeT = age / BLIP_LIFETIME_MS;
        const fadeOut = Math.pow(1 - lifeT, 1.6);
        const lifeAlpha = fadeIn * fadeOut;

        // Map normalized (0..1, 0..1) into the radar's bounding box.
        const px = cx + (b.x - 0.5) * 2 * radius;
        const py = cy + (b.y - 0.5) * 2 * radius;

        // Skip blips outside the radar disc (with a small margin).
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy > radius * radius * 1.02) {
          alive.push(b);
          continue;
        }

        // Sweep-pulse boost: 1.0 right after a hit, decays to 0 over PULSE_DURATION_MS.
        let pulse = 0;
        if (b.lastPingAt) {
          const pingAge = nowMs - b.lastPingAt;
          if (pingAge >= 0 && pingAge < PULSE_DURATION_MS) {
            pulse = Math.pow(1 - pingAge / PULSE_DURATION_MS, 2);
          }
        }

        const sizeT = 0.4 + 0.6 * b.intensity;
        const baseR =
          (BLIP_MIN_RADIUS + (BLIP_MAX_RADIUS - BLIP_MIN_RADIUS) * sizeT) *
          (1 + 0.55 * pulse);
        const glowR = baseR * (3.2 + 1.6 * pulse);
        const brightness =
          Math.min(1, (0.45 + 0.55 * b.intensity) * lifeAlpha + 0.45 * pulse * lifeAlpha);

        // Outer soft glow.
        const glow = ctx.createRadialGradient(px, py, 0, px, py, glowR);
        glow.addColorStop(0, `rgba(57, 255, 156, ${(0.55 * brightness).toFixed(4)})`);
        glow.addColorStop(0.45, `rgba(57, 255, 156, ${(0.18 * brightness).toFixed(4)})`);
        glow.addColorStop(1, "rgba(57, 255, 156, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(px, py, glowR, 0, Math.PI * 2);
        ctx.fill();

        // Bright core.
        ctx.fillStyle = `rgba(220, 255, 235, ${(0.85 * brightness).toFixed(4)})`;
        ctx.beginPath();
        ctx.arc(px, py, baseR, 0, Math.PI * 2);
        ctx.fill();

        // Hot center.
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.9 * brightness).toFixed(4)})`;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.8, baseR * 0.35), 0, Math.PI * 2);
        ctx.fill();

        alive.push(b);
      }
      this._blips = alive;

      ctx.restore();
    },

    _drawRipples(ctx, cx, cy, radius, nowMs) {
      if (this._ripples.length === 0) return;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();

      const alive = [];
      for (let i = 0; i < this._ripples.length; i++) {
        const r = this._ripples[i];
        const age = nowMs - r.bornAt;
        if (age >= RIPPLE_DURATION_MS) continue;

        const t = age / RIPPLE_DURATION_MS;
        const eased = 1 - Math.pow(1 - t, 2); // ease-out radius growth
        const px = cx + (r.x - 0.5) * 2 * radius;
        const py = cy + (r.y - 0.5) * 2 * radius;

        const startR = 4 + 4 * r.intensity;
        const ringR = startR + RIPPLE_EXPAND_PX * (0.5 + 0.5 * r.intensity) * eased;
        const alpha = (1 - t) * (0.35 + 0.45 * r.intensity);

        ctx.strokeStyle = `rgba(57, 255, 156, ${alpha.toFixed(4)})`;
        ctx.lineWidth = 1.5 * (1 - t) + 0.4;
        ctx.shadowColor = COLOR_GLOW;
        ctx.shadowBlur = 8 * (1 - t);
        ctx.beginPath();
        ctx.arc(px, py, ringR, 0, Math.PI * 2);
        ctx.stroke();

        alive.push(r);
      }
      this._ripples = alive;

      ctx.restore();
    },

    _drawSweep(ctx, cx, cy, radius, angle) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();

      const segments = SWEEP_SEGMENTS;
      const trail = SWEEP_TRAIL_RAD;
      const step = trail / segments;

      for (let i = 0; i < segments; i++) {
        const t = i / segments;
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

  function clamp01(n) {
    const v = typeof n === "number" ? n : Number(n);
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  window.Radar = Radar;
})();
