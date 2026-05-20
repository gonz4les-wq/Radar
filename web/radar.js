/*
 * radar.js — radar renderer.
 *
 *  Step 1: static rings, crosshair, ticks, neon framing.
 *  Step 2: clockwise sweep with bright leading edge and fading trail.
 *  Step 4: incoming blips drawn as glowing dots that fade smoothly.
 *  Step 5: blips pulse + emit a ripple when the sweep passes over them.
 *  Step 7: static layers cached, blip sprite baked, conic-gradient
 *          sweep — designed for 60fps on mobile Safari.
 *  Step 9: 8 environmental zones rendered as a soft heatmap ring.
 *  Step 11: persistent activity heatmap — a ghost layer that
 *           accumulates the live zone snapshot each frame and decays
 *           exponentially toward black for a smooth temporal trail.
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

  // Zones (live snapshot)
  const ZONE_COUNT = 8;
  const ZONE_SMOOTH_RATE = 6.5; // per-second exponential approach
  const ZONE_SKIP_EPSILON = 0.015;

  // Temporal heatmap (persistent layer)
  const PERSIST_HALF_LIFE_MS = 2400;
  const PERSIST_LAMBDA = Math.LN2 / PERSIST_HALF_LIFE_MS;
  const PERSIST_ACC_BOOST = 1.15;          // accumulation overshoot vs decay
  const PERSIST_COMPOSITE_ALPHA = 0.6;     // brightness of the ghost layer
  const PERSIST_IDLE_TIMEOUT_MS = 8000;    // skip composite once long-idle

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
    _lastFrameTs: 0,
    _dtMs: 16,

    _blips: [],
    _ripples: [],
    _zones: null,

    _staticLayer: null,
    _blipSprite: null,
    _zoneLayer: null,
    _zoneLayerCtx: null,
    _persistLayer: null,
    _persistLayerCtx: null,
    _persistLastAccumMs: 0,

    _supportsConic: false,
    _resizePending: false,
    _ro: null,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: true });
      this._supportsConic =
        typeof this.ctx.createConicGradient === "function";
      this._blipSprite = this._buildBlipSprite();
      this._zones = new Array(ZONE_COUNT);
      for (let i = 0; i < ZONE_COUNT; i++) {
        this._zones[i] = { activity: 0, target: 0 };
      }

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

      window.addEventListener("radar:data", (evt) => {
        const d = evt.detail || {};
        this.ingest(d.blips);
        this.ingestZones(d.zones);
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
      this._buildOffscreenLayer("_zoneLayer", "_zoneLayerCtx");
      this._buildOffscreenLayer("_persistLayer", "_persistLayerCtx");
      this._persistLastAccumMs = 0;
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

      const halo = g.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
      halo.addColorStop(0.0, "rgba(57, 255, 156, 0.55)");
      halo.addColorStop(0.45, "rgba(57, 255, 156, 0.18)");
      halo.addColorStop(1.0, "rgba(57, 255, 156, 0)");
      g.fillStyle = halo;
      g.fillRect(0, 0, size, size);

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

    _buildOffscreenLayer(canvasKey, ctxKey) {
      if (!this[canvasKey]) {
        this[canvasKey] = document.createElement("canvas");
        this[ctxKey] = this[canvasKey].getContext("2d");
      }
      this[canvasKey].width = this.width * this.dpr;
      this[canvasKey].height = this.height * this.dpr;
      this[ctxKey].setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    },

    _clearPersistLayer() {
      if (!this._persistLayer || !this._persistLayerCtx) return;
      const c = this._persistLayer;
      const g = this._persistLayerCtx;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._persistLastAccumMs = 0;
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

    ingestZones(zones) {
      if (!Array.isArray(zones)) return;
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        if (!z) continue;
        const idx = z.sector;
        if (typeof idx !== "number" || idx < 0 || idx >= ZONE_COUNT) continue;
        const a = clamp01(z.activity);
        if (Number.isNaN(a)) continue;
        this._zones[idx | 0].target = a;
      }
    },

    // ---------- Animation loop ----------

    _start() {
      if (this._rafId) return;
      // Fresh start (init or resume from hidden tab) — wipe persistence
      // so we don't surface stale history from minutes ago.
      this._clearPersistLayer();
      const loop = (ts) => {
        if (!this._startTs) {
          this._startTs = ts;
          this._prevAngle = this._angle;
          this._lastFrameTs = ts;
        }
        const elapsed = ts - this._startTs;
        const t = (elapsed % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS;
        this._prevAngle = this._angle;
        this._angle = -Math.PI / 2 + t * TAU;
        const dtMs = ts - this._lastFrameTs;
        this._lastFrameTs = ts;
        this._dtMs = Math.min(100, Math.max(1, dtMs || 16));
        this._updateZones(this._dtMs);
        this.render(ts);
        this._rafId = requestAnimationFrame(loop);
      };
      this._rafId = requestAnimationFrame(loop);
    },

    _stop() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = 0;
      this._startTs = 0;
      this._lastFrameTs = 0;
    },

    _updateZones(dtMs) {
      const dt = Math.min(0.1, Math.max(0, dtMs / 1000));
      const k = 1 - Math.exp(-dt * ZONE_SMOOTH_RATE);
      for (let i = 0; i < ZONE_COUNT; i++) {
        const z = this._zones[i];
        z.activity += (z.target - z.activity) * k;
      }
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

      this._drawZones(ctx, cx, cy, radius, nowMs);
      this._detectSweepHits(nowMs);
      this._drawBlips(ctx, cx, cy, radius, nowMs);
      this._drawRipples(ctx, cx, cy, radius, nowMs);
      this._drawSweep(ctx, cx, cy, radius, this._angle);
      this._drawCenter(ctx, cx, cy);
      this._drawFrame(ctx, cx, cy, radius);
    },

    // ---------- Zones: live snapshot + temporal persistence ----------

    _drawZones(ctx, cx, cy, radius, nowMs) {
      if (!this._zoneLayer || !this._persistLayer) return;

      const lctx = this._zoneLayerCtx;
      const pctx = this._persistLayerCtx;
      const w = this.width;
      const h = this.height;

      // Sum activity to decide if we have anything to render this frame.
      let total = 0;
      for (let i = 0; i < ZONE_COUNT; i++) total += this._zones[i].activity;
      const hasActivity = total >= ZONE_SKIP_EPSILON;

      // ---- 1. Render the live snapshot into _zoneLayer.
      lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      lctx.clearRect(0, 0, w, h);
      if (hasActivity) {
        this._renderZoneSnapshot(lctx, cx, cy, radius, nowMs);
      }

      // ---- 2. Decay the persistence layer toward black.
      const fadeAlpha = 1 - Math.exp(-PERSIST_LAMBDA * this._dtMs);
      if (fadeAlpha > 0.0008) {
        pctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        pctx.globalCompositeOperation = "destination-out";
        pctx.fillStyle = "rgba(0, 0, 0, " + fadeAlpha.toFixed(4) + ")";
        pctx.fillRect(0, 0, w, h);
        pctx.globalCompositeOperation = "source-over";
      }

      // ---- 3. Accumulate the live snapshot into the persistence layer.
      if (hasActivity) {
        const accAlpha = Math.min(1, fadeAlpha * PERSIST_ACC_BOOST);
        if (accAlpha > 0.0005) {
          pctx.globalAlpha = accAlpha;
          pctx.drawImage(this._zoneLayer, 0, 0, w, h);
          pctx.globalAlpha = 1;
          this._persistLastAccumMs = nowMs;
        }
      }

      // ---- 4. Composite both onto the main canvas (additive glow).
      const persistAge = this._persistLastAccumMs
        ? nowMs - this._persistLastAccumMs
        : Infinity;
      const persistVisible = persistAge < PERSIST_IDLE_TIMEOUT_MS;

      if (!persistVisible && !hasActivity) return;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      if (persistVisible) {
        // Fade composite alpha as the layer ages out, so the ghost
        // bows out smoothly instead of vanishing at the timeout.
        const tail =
          persistAge < PERSIST_IDLE_TIMEOUT_MS * 0.5
            ? 1
            : 1 -
              (persistAge - PERSIST_IDLE_TIMEOUT_MS * 0.5) /
                (PERSIST_IDLE_TIMEOUT_MS * 0.5);
        ctx.globalAlpha = PERSIST_COMPOSITE_ALPHA * Math.max(0, tail);
        ctx.drawImage(this._persistLayer, 0, 0, w, h);
      }
      if (hasActivity) {
        ctx.globalAlpha = 1;
        ctx.drawImage(this._zoneLayer, 0, 0, w, h);
      }
      ctx.restore();
    },

    _renderZoneSnapshot(lctx, cx, cy, radius, nowMs) {
      lctx.save();
      lctx.beginPath();
      lctx.arc(cx, cy, radius, 0, TAU);
      lctx.clip();

      const breath = 0.88 + 0.12 * Math.sin(nowMs * 0.0017);

      if (this._supportsConic) {
        const conic = lctx.createConicGradient(-Math.PI / 2, cx, cy);
        for (let i = 0; i <= ZONE_COUNT; i++) {
          const idx = i % ZONE_COUNT;
          const z = this._zones[idx];
          const sectorPulse =
            0.85 + 0.15 * Math.sin(nowMs * 0.0028 + idx * 0.65);
          const a = clamp01(z.activity * breath * sectorPulse);
          const alpha = (0.04 + 0.55 * a).toFixed(4);
          const rr = 57 + Math.round((77 - 57) * a);
          const bb = 156 + Math.round((226 - 156) * a);
          conic.addColorStop(
            i / ZONE_COUNT,
            "rgba(" + rr + ", 255, " + bb + ", " + alpha + ")"
          );
        }
        lctx.fillStyle = conic;
        lctx.fillRect(
          cx - radius - 1,
          cy - radius - 1,
          radius * 2 + 2,
          radius * 2 + 2
        );
      } else {
        this._drawZonesWedgeFallback(lctx, cx, cy, radius, nowMs, breath);
      }

      // Radial mask: fade toward centre, keep bright bloom on the rim.
      lctx.globalCompositeOperation = "destination-in";
      const mask = lctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      mask.addColorStop(0.0, "rgba(0, 0, 0, 0)");
      mask.addColorStop(0.3, "rgba(0, 0, 0, 0)");
      mask.addColorStop(0.55, "rgba(0, 0, 0, 0.22)");
      mask.addColorStop(0.8, "rgba(0, 0, 0, 0.75)");
      mask.addColorStop(1.0, "rgba(0, 0, 0, 1)");
      lctx.fillStyle = mask;
      lctx.fillRect(
        cx - radius - 1,
        cy - radius - 1,
        radius * 2 + 2,
        radius * 2 + 2
      );
      lctx.globalCompositeOperation = "source-over";
      lctx.restore();
    },

    _drawZonesWedgeFallback(lctx, cx, cy, radius, nowMs, breath) {
      const SECTOR_RAD = TAU / ZONE_COUNT;
      const innerR = radius * 0.3;
      const outerR = radius * 1.0;
      for (let i = 0; i < ZONE_COUNT; i++) {
        const z = this._zones[i];
        const sectorPulse = 0.85 + 0.15 * Math.sin(nowMs * 0.0028 + i * 0.65);
        const a = clamp01(z.activity * breath * sectorPulse);
        if (a < 0.02) continue;

        const angle0 = -Math.PI / 2 - SECTOR_RAD / 2 + i * SECTOR_RAD;
        const angle1 = angle0 + SECTOR_RAD;
        const alpha = 0.04 + 0.55 * a;
        const rr = 57 + Math.round((77 - 57) * a);
        const bb = 156 + Math.round((226 - 156) * a);

        const grad = lctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
        grad.addColorStop(0, "rgba(" + rr + ", 255, " + bb + ", 0)");
        grad.addColorStop(
          0.6,
          "rgba(" + rr + ", 255, " + bb + ", " + (alpha * 0.4).toFixed(4) + ")"
        );
        grad.addColorStop(
          1,
          "rgba(" + rr + ", 255, " + bb + ", " + alpha.toFixed(4) + ")"
        );
        lctx.fillStyle = grad;
        lctx.beginPath();
        lctx.moveTo(
          cx + Math.cos(angle0) * innerR,
          cy + Math.sin(angle0) * innerR
        );
        lctx.arc(cx, cy, outerR, angle0, angle1, false);
        lctx.arc(cx, cy, innerR, angle1, angle0, true);
        lctx.closePath();
        lctx.fill();
      }
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

        ctx.strokeStyle = "rgba(57, 255, 156, " + alpha.toFixed(4) + ")";
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
          ctx.fillStyle = "rgba(57, 255, 156, " + alpha.toFixed(4) + ")";
          ctx.fill();
        }
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
