/*
 * radar.js — radar renderer with sweep, blips, sweep interaction.
 *
 * Optimization notes for Step 7:
 *  - Backdrop, rings, crosshair and ticks are pre-rendered to an offscreen
 *    canvas once per resize and blitted each frame (no per-frame strokes).
 *  - Blips are drawn from a baked glow sprite via drawImage — no
 *    createRadialGradient per blip per frame.
 *  - The sweep trail uses a single createConicGradient fill where
 *    available (Safari 14+ / all modern browsers); a 14-segment
 *    fallback covers older runtimes.
 *  - Device pixel ratio is capped at 2 to avoid massive backing stores
 *    on retina phones.
 *  - Resize is observed via ResizeObserver and throttled to a single
 *    rAF callback to avoid thrash during iOS address-bar transitions.
 *  - rAF is paused on visibilitychange to save battery in background.
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
  const SWEEP_FALLBACK_SEGMENTS = 14;

  // Blips
  const BLIP_LIFETIME_MS = 3500;
  const BLIP_FADE_IN_MS = 220;
  const BLIP_MIN_RADIUS = 3.0;
  const BLIP_MAX_RADIUS = 9.5;
  const BLIP_MAX_ACTIVE = 256;

  // Sweep-pass interaction
  const PULSE_DURATION_MS = 650;
  const RIPPLE_DURATION_MS = 800;
  const RIPPLE_EXPAND_PX = 38;
  const RIPPLE_MAX_ACTIVE = 64;

  // Performance
  const SPRITE_SIZE = 128;
  const DPR_CAP = 2;
  const TAU = Math.PI * 2;

  // ---------- Radar singleton ----------

  const Radar = {
    canvas: null,
    ctx: null,
    dpr: 0,
    width: 0,
    height: 0,
    cx: 0,
    cy: 0,
    radius: 0,

    _rafId: 0,
    _startTs: 0,
    _angle: -Math.PI / 2,
    _prevAngle: -Math.PI / 2,
    _blips: [],
    _ripples: [],

    _staticLayer: null,
    _blipSprite: null,
    _supportsConic: false,
    _resizePending: false,
    _ro: null,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: true });
      this._supportsConic =
        typeof this.ctx.createConicGradient === "function";
      this._blipSprite = this._buildBlipSprite();

      this.resize(true);

      if (typeof ResizeObserver !== "undefined") {
        this._ro = new ResizeObserver(() => this._scheduleResize());
        this._ro.observe(canvas);
      }
      window.addEventListener("resize", () => this._scheduleResize(), {
        passive: true,
      });
      window.addEventListener(
        "orientationchange",
        () => this._scheduleResize(),
        { passive: true }
      );
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this._stop();
        else this._start();
      });

      // Backend payload from app.js
      window.addEventListener("radar:data", (evt) => {
        this.ingest(evt.detail && evt.detail.blips);
      });

      this._start();
    },

    // ---------- Sizing ----------

    _scheduleResize() {
      if (this._resizePending) return;
      this._resizePending = true;
      requestAnimationFrame(() => {
        this._resizePending = false;
        this.resize(false);
      });
    },

    resize(force) {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));

      if (!force && w === this.width && h === this.height && dpr === this.dpr) {
        return;
      }

      this.dpr = dpr;
      this.width = w;
      this.height = h;
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cx = w / 2;
      this.cy = h / 2;
      this.radius = Math.min(w, h) * 0.46;

      this._staticLayer = this._buildStaticLayer();
    },

    // ---------- Pre-rendered layers ----------

    _buildStaticLayer() {
      const w = this.width;
      const h = this.height;
      const dpr = this.dpr;
      const oc = document.createElement("canvas");
      oc.width = w * dpr;
      oc.height = h * dpr;
      const g = oc.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._drawBackdrop(g, this.cx, this.cy, this.radius);
      this._drawRings(g, this.cx, this.cy, this.radius);
      this._drawCrosshair(g, this.cx, this.cy, this.radius);
      this._drawTicks(g, this.cx, this.cy, this.radius);
      return oc;
    },

    _buildBlipSprite() {
      const size = SPRITE_SIZE;
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const g = c.getContext("2d");
      const cx = size / 2;
      const cy = size / 2;

      // Outer halo
      const halo = g.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
      halo.addColorStop(0.0, "rgba(57, 255, 156, 0.55)");
      halo.addColorStop(0.45, "rgba(57, 255, 156, 0.18)");
      halo.addColorStop(1.0, "rgba(57, 255, 156, 0)");
      g.fillStyle = halo;
      g.fillRect(0, 0, size, size);

      // Bright core + hot center, blended via radial gradient.
      const coreR = size * 0.17;
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      core.addColorStop(0.0, "rgba(255, 255, 255, 0.95)");
      core.addColorStop(0.5, "rgba(220, 255, 235, 0.85)");
      core.addColorStop(1.0, "rgba(220, 255, 235, 0)");
      g.fillStyle = core;
      g.beginPath();
      g.arc(cx, cy, coreR, 0, TAU);
      g.fill();

      return c;
    },

    // ---------- Data ingest ----------

    ingest(blips) {
      if (!Array.isArray(blips) || blips.length === 0) return;
      const now = performance.now();
      for (let i = 0; i < blips.length; i++) {
        const b = blips[i];
        if (!b) continue;
        const x = clamp01(b.x);
        const y = clamp01(b.y);
        const intensity = clamp01(b.intensity);
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        this._blips.push({ x, y, intensity, bornAt: now, lastPingAt: 0 });
      }
      if (this._blips.length > BLIP_MAX_ACTIVE) {
        this._blips.splice(0, this._blips.length - BLIP_MAX_ACTIVE);
      }
    },

    // ---------- Animation loop ----------

    _start() {
      if (this._rafId) return;
      const loop = (ts) => {
        if (!this._startTs) {
          this._startTs = ts;
          this._prevAngle = this._angle;
        }
        const elapsed = ts - this._startTs;
        const t = (elapsed % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS;
        this._prevAngle = this._angle;
        this._angle = -Math.PI / 2 + t * TAU;
        this.render(ts);
        this._rafId = requestAnimationFrame(loop);
      };
      this._rafId = requestAnimationFrame(loop);
    },

    _stop() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = 0;
      this._startTs = 0;
    },

    render(nowMs) {
      const ctx = this.ctx;
      if (!ctx || !this._staticLayer) return;

      const w = this.width;
      const h = this.height;
      const cx = this.cx;
      const cy = this.cy;
      const radius = this.radius;

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._staticLayer, 0, 0, w, h);

      this._detectSweepHits(nowMs);
      this._drawBlips(ctx, cx, cy, radius, nowMs);
      this._drawRipples(ctx, cx, cy, radius, nowMs);
      this._drawSweep(ctx, cx, cy, radius, this._angle);
      this._drawCenter(ctx, cx, cy);
      this._drawFrame(ctx, cx, cy, radius);
    },

    // ---------- Sweep interaction ----------

    _detectSweepHits(nowMs) {
      if (this._blips.length === 0) return;
      let delta = this._angle - this._prevAngle;
      delta = ((delta % TAU) + TAU) % TAU;
      if (delta <= 0) return;

      const cx = this.cx;
      const cy = this.cy;
      const radius = this.radius;
      const prev = ((this._prevAngle % TAU) + TAU) % TAU;
      const debounce = PULSE_DURATION_MS * 0.6;

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
          if (nowMs - b.lastPingAt < debounce) continue;
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

    // ---------- Dynamic draw passes ----------

    _drawBlips(ctx, cx, cy, radius, nowMs) {
      const n = this._blips.length;
      if (n === 0) return;
      const sprite = this._blipSprite;
      if (!sprite) return;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.clip();

      const alive = [];
      const r2 = radius * radius * 1.02;
      for (let i = 0; i < n; i++) {
        const b = this._blips[i];
        const age = nowMs - b.bornAt;
        if (age >= BLIP_LIFETIME_MS) continue;

        const fadeIn = age < BLIP_FADE_IN_MS ? age / BLIP_FADE_IN_MS : 1;
        const lifeT = age / BLIP_LIFETIME_MS;
        const fadeOut = Math.pow(1 - lifeT, 1.6);
        const lifeAlpha = fadeIn * fadeOut;

        const px = cx + (b.x - 0.5) * 2 * radius;
        const py = cy + (b.y - 0.5) * 2 * radius;
        const dx = px - cx;
        const dy = py - cy;

        let pulse = 0;
        if (b.lastPingAt) {
          const pingAge = nowMs - b.lastPingAt;
          if (pingAge >= 0 && pingAge < PULSE_DURATION_MS) {
            const k = 1 - pingAge / PULSE_DURATION_MS;
            pulse = k * k;
          }
        }

        if (dx * dx + dy * dy <= r2) {
          const sizeT = 0.4 + 0.6 * b.intensity;
          const baseR =
            (BLIP_MIN_RADIUS + (BLIP_MAX_RADIUS - BLIP_MIN_RADIUS) * sizeT) *
            (1 + 0.55 * pulse);
          const spriteR = baseR * 3.2 + 1.4 * baseR * pulse;
          const brightness =
            (0.45 + 0.55 * b.intensity) * lifeAlpha + 0.45 * pulse * lifeAlpha;
          const a = brightness > 1 ? 1 : brightness;
          if (a > 0.01) {
            ctx.globalAlpha = a;
            ctx.drawImage(
              sprite,
              px - spriteR,
              py - spriteR,
              spriteR * 2,
              spriteR * 2
            );
          }
        }

        alive.push(b);
      }
      this._blips = alive;
      ctx.globalAlpha = 1;
      ctx.restore();
    },

    _drawRipples(ctx, cx, cy, radius, nowMs) {
      const n = this._ripples.length;
      if (n === 0) return;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.clip();

      const alive = [];
      for (let i = 0; i < n; i++) {
        const r = this._ripples[i];
        const age = nowMs - r.bornAt;
        if (age >= RIPPLE_DURATION_MS) continue;

        const t = age / RIPPLE_DURATION_MS;
        const oneMinusT = 1 - t;
        const eased = 1 - oneMinusT * oneMinusT;
        const px = cx + (r.x - 0.5) * 2 * radius;
        const py = cy + (r.y - 0.5) * 2 * radius;

        const startR = 4 + 4 * r.intensity;
        const ringR =
          startR + RIPPLE_EXPAND_PX * (0.5 + 0.5 * r.intensity) * eased;
        const alpha = oneMinusT * (0.35 + 0.45 * r.intensity);

        ctx.strokeStyle = `rgba(57, 255, 156, ${alpha.toFixed(4)})`;
        ctx.lineWidth = 1.5 * oneMinusT + 0.4;
        ctx.beginPath();
        ctx.arc(px, py, ringR, 0, TAU);
        ctx.stroke();

        alive.push(r);
      }
      this._ripples = alive;
      ctx.restore();
    },

    _drawSweep(ctx, cx, cy, radius, angle) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.clip();

      if (this._supportsConic) {
        const trailFrac = SWEEP_TRAIL_RAD / TAU;
        const grad = ctx.createConicGradient(angle - SWEEP_TRAIL_RAD, cx, cy);
        grad.addColorStop(0, "rgba(57, 255, 156, 0)");
        grad.addColorStop(trailFrac * 0.5, "rgba(57, 255, 156, 0.05)");
        grad.addColorStop(trailFrac * 0.8, "rgba(57, 255, 156, 0.16)");
        grad.addColorStop(trailFrac * 0.95, "rgba(57, 255, 156, 0.27)");
        grad.addColorStop(trailFrac, "rgba(57, 255, 156, 0.32)");
        grad.addColorStop(
          Math.min(1, trailFrac + 0.0005),
          "rgba(57, 255, 156, 0)"
        );
        grad.addColorStop(1, "rgba(57, 255, 156, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(
          cx - radius - 1,
          cy - radius - 1,
          radius * 2 + 2,
          radius * 2 + 2
        );
      } else {
        const segs = SWEEP_FALLBACK_SEGMENTS;
        const step = SWEEP_TRAIL_RAD / segs;
        for (let i = 0; i < segs; i++) {
          const t = i / segs;
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
      }

      // Bright leading edge
      const ex = cx + Math.cos(angle) * radius;
      const ey = cy + Math.sin(angle) * radius;
      const lineGrad = ctx.createLinearGradient(cx, cy, ex, ey);
      lineGrad.addColorStop(0, "rgba(57, 255, 156, 0.95)");
      lineGrad.addColorStop(0.6, "rgba(57, 255, 156, 0.75)");
      lineGrad.addColorStop(1, "rgba(57, 255, 156, 0.15)");

      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = COLOR_GLOW;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      ctx.shadowBlur = 12;
      ctx.fillStyle = COLOR_NEON;
      ctx.beginPath();
      ctx.arc(ex, ey, 2.4, 0, TAU);
      ctx.fill();

      ctx.restore();
    },

    _drawCenter(ctx, cx, cy) {
      ctx.save();
      ctx.fillStyle = COLOR_NEON;
      ctx.shadowColor = COLOR_GLOW;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.2, 0, TAU);
      ctx.fill();
      ctx.restore();
    },

    _drawFrame(ctx, cx, cy, radius) {
      ctx.save();
      ctx.strokeStyle = COLOR_NEON;
      ctx.shadowColor = COLOR_GLOW;
      ctx.shadowBlur = 5;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.stroke();
      ctx.restore();
    },

    // ---------- Static primitives (used to build the cached layer) ----------

    _drawBackdrop(ctx, cx, cy, radius) {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.05);
      grad.addColorStop(0, COLOR_BG_RADIAL_INNER);
      grad.addColorStop(1, COLOR_BG_RADIAL_OUTER);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.05, 0, TAU);
      ctx.fill();
    },

    _drawRings(ctx, cx, cy, radius) {
      ctx.save();
      ctx.lineWidth = 1;
      for (let i = 1; i <= RING_COUNT; i++) {
        const r = (radius * i) / RING_COUNT;
        ctx.strokeStyle = i === RING_COUNT ? COLOR_RING : COLOR_RING_FAINT;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
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
        const angle = (i / tickCount) * TAU;
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
  };

  function clamp01(n) {
    const v = typeof n === "number" ? n : Number(n);
    if (Number.isNaN(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  window.Radar = Radar;
})();
