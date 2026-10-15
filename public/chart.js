// TradingView-flavoured candlestick renderer.
//
// Deliberately dependency-free: a single canvas draw call per state change, plus
// a lightweight crosshair overlay. Everything comes from `/api/stocks/:code/history`
// so the chart never recomputes indicators in the browser.

const UP = "#e5484d"; // 红涨
const DOWN = "#2f9e6f"; // 绿跌
const PALETTE = {
  light: {
    bg: "#ffffff",
    grid: "#eceff4",
    axis: "#8b93a7",
    text: "#4b5567",
    band: "rgba(94,129,244,0.10)",
    bandLine: "rgba(94,129,244,0.55)",
    crosshair: "#9aa3b5",
    tooltipBg: "rgba(23,28,38,0.92)",
    tooltipText: "#f6f7fb"
  },
  dark: {
    bg: "#141922",
    grid: "#232a36",
    axis: "#7f8899",
    text: "#c3cad8",
    band: "rgba(120,150,255,0.12)",
    bandLine: "rgba(120,150,255,0.55)",
    crosshair: "#5c6678",
    tooltipBg: "rgba(240,243,250,0.94)",
    tooltipText: "#141922"
  }
};

const MA_COLORS = { 5: "#f2a33c", 10: "#3f8cff", 15: "#b56cff", 20: "#00b3a4" };

function theme() {
  return PALETTE[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];
}

function setupCanvas(canvas) {
  const width = Math.max(canvas.clientWidth || 960, 320);
  const height = Math.max(canvas.clientHeight || 420, 240);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) || magnitude;
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{bars:Array, indicators:object, plan:object}} payload
 * @param {{range:number, overlays:Set<string>, hover:number|null}} options
 */
export function drawPriceChart(canvas, payload, options = {}) {
  const colors = theme();
  const { ctx, width, height } = setupCanvas(canvas);
  const bars = (payload?.bars || []).slice(-Math.max(options.range || 120, 2));
  const indicators = payload?.indicators || {};
  const plan = payload?.plan || null;
  const overlays = options.overlays || new Set(["ma5", "ma10", "ma15", "ma20", "boll", "volume"]);

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  if (bars.length === 0) return null;

  const padTop = 18;
  const padBottom = 26;
  const padRight = 62;
  const padLeft = 6;
  const showVolume = overlays.has("volume");
  const totalH = height - padTop - padBottom;
  const volumeH = showVolume ? Math.round(totalH * 0.22) : 0;
  const gap = showVolume ? 12 : 0;
  const priceH = totalH - volumeH - gap;
  const plotW = width - padLeft - padRight;

  // Align indicator arrays with the visible window (they were returned tail-aligned).
  const offset = (indicators.ma?.[5]?.length || bars.length) - bars.length;
  const at = (series, i) => (Array.isArray(series) ? series[offset + i] ?? null : null);

  let min = Infinity;
  let max = -Infinity;
  for (const bar of bars) {
    min = Math.min(min, bar.low);
    max = Math.max(max, bar.high);
  }
  const consider = (series) => {
    if (!Array.isArray(series)) return;
    for (let i = 0; i < bars.length; i += 1) {
      const value = at(series, i);
      if (Number.isFinite(value)) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  };
  if (overlays.has("boll")) {
    consider(indicators.boll?.upper);
    consider(indicators.boll?.lower);
  }
  for (const key of ["ma5", "ma10", "ma15", "ma20"]) {
    if (overlays.has(key)) consider(indicators.ma?.[key.slice(2)]);
  }
  if (plan) {
    if (Number.isFinite(plan.stopLoss)) min = Math.min(min, plan.stopLoss);
    if (Number.isFinite(plan.target)) max = Math.max(max, plan.target);
  }
  const pad = (max - min) * 0.06 || 1;
  min -= pad;
  max += pad;

  const slot = plotW / bars.length;
  const xFor = (i) => padLeft + slot * (i + 0.5);
  const yFor = (price) => padTop + ((max - price) / (max - min)) * priceH;
  const volTop = padTop + priceH + gap;
  let volMax = 0;
  for (const bar of bars) volMax = Math.max(volMax, bar.volume || 0);
  const yVol = (volume) => volTop + volumeH - (volMax ? (volume / volMax) * volumeH : 0);

  // Grid + price axis.
  ctx.font = "11px -apple-system, 'Segoe UI', 'PingFang SC', sans-serif";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  for (const tick of niceTicks(min, max, 5)) {
    const y = Math.round(yFor(tick)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.fillStyle = colors.axis;
    ctx.textAlign = "left";
    ctx.fillText(tick >= 1000 ? tick.toFixed(0) : tick.toFixed(2), padLeft + plotW + 6, y);
  }

  // Bollinger band fill.
  if (overlays.has("boll") && indicators.boll?.upper) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < bars.length; i += 1) {
      const value = at(indicators.boll.upper, i);
      if (!Number.isFinite(value)) continue;
      const x = xFor(i);
      const y = yFor(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    for (let i = bars.length - 1; i >= 0; i -= 1) {
      const value = at(indicators.boll.lower, i);
      if (!Number.isFinite(value)) continue;
      ctx.lineTo(xFor(i), yFor(value));
    }
    if (started) {
      ctx.closePath();
      ctx.fillStyle = colors.band;
      ctx.fill();
    }
  }

  // Candles.
  const bodyW = Math.max(Math.min(slot * 0.68, 14), 1.2);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const up = bar.close >= bar.open;
    const color = up ? UP : DOWN;
    const x = xFor(i);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(Math.min(slot * 0.12, 1.6), 0.8);
    ctx.beginPath();
    ctx.moveTo(x, yFor(bar.high));
    ctx.lineTo(x, yFor(bar.low));
    ctx.stroke();
    const top = yFor(Math.max(bar.open, bar.close));
    const bottom = yFor(Math.min(bar.open, bar.close));
    ctx.fillRect(x - bodyW / 2, top, bodyW, Math.max(bottom - top, 1));
  }

  // Volume bars.
  if (showVolume && volMax > 0) {
    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      const up = bar.close >= bar.open;
      ctx.fillStyle = up ? "rgba(229,72,77,0.45)" : "rgba(47,158,111,0.45)";
      const x = xFor(i) - bodyW / 2;
      const y = yVol(bar.volume || 0);
      ctx.fillRect(x, y, bodyW, volTop + volumeH - y);
    }
    ctx.fillStyle = colors.axis;
    ctx.textAlign = "left";
    ctx.fillText(formatVolume(volMax), padLeft + plotW + 6, volTop + 8);
  }

  // Moving averages.
  const line = (series, color, dashed = false) => {
    if (!Array.isArray(series)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < bars.length; i += 1) {
      const value = at(series, i);
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const x = xFor(i);
      const y = yFor(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };

  if (overlays.has("boll")) {
    line(indicators.boll?.upper, colors.bandLine, true);
    line(indicators.boll?.middle, colors.bandLine);
    line(indicators.boll?.lower, colors.bandLine, true);
  }
  for (const key of ["ma5", "ma10", "ma15", "ma20"]) {
    if (overlays.has(key)) line(indicators.ma?.[key.slice(2)], MA_COLORS[key.slice(2)]);
  }

  // Buy-zone and stop/target markers.
  const marker = (price, color, label, dash) => {
    if (!Number.isFinite(price)) return;
    const y = Math.round(yFor(price)) + 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = "right";
    ctx.fillText(label, padLeft + plotW - 4, y - 8);
  };
  if (plan) {
    for (const zone of (plan.buyZones || []).slice(0, 3)) marker(zone.price, "#3f8cff", "买点", [5, 4]);
    marker(plan.stopLoss, DOWN, "止损", [2, 3]);
    marker(plan.target, UP, "目标", [2, 3]);
  }

  // Date axis.
  ctx.fillStyle = colors.axis;
  ctx.textAlign = "center";
  const labels = Math.min(bars.length, Math.max(Math.floor(plotW / 90), 2));
  for (let i = 0; i < labels; i += 1) {
    const index = Math.round((i * (bars.length - 1)) / Math.max(labels - 1, 1));
    ctx.fillText(bars[index].date.slice(5), xFor(index), height - padBottom / 2 - 2);
  }

  // Crosshair + tooltip.
  const hover = options.hover;
  if (Number.isInteger(hover) && hover >= 0 && hover < bars.length) {
    const bar = bars[hover];
    const x = Math.round(xFor(hover)) + 0.5;
    ctx.strokeStyle = colors.crosshair;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, height - padBottom);
    ctx.stroke();
    const y = Math.round(yFor(bar.close)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const lines = [
      bar.date,
      `开 ${bar.open.toFixed(2)}  高 ${bar.high.toFixed(2)}`,
      `低 ${bar.low.toFixed(2)}  收 ${bar.close.toFixed(2)}`,
      `量 ${formatVolume(bar.volume)}`
    ];
    const boxW = 148;
    const boxH = lines.length * 15 + 10;
    const boxX = Math.min(Math.max(x + 10, padLeft), padLeft + plotW - boxW);
    const boxY = padTop + 4;
    ctx.fillStyle = colors.tooltipBg;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = colors.tooltipText;
    ctx.textAlign = "left";
    lines.forEach((text, index) => ctx.fillText(text, boxX + 8, boxY + 14 + index * 15));
  }

  return { bars, xFor, slot, offsetLeft: padLeft, count: bars.length };
}

function formatVolume(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿手`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万手`;
  return `${Math.round(value)}手`;
}
