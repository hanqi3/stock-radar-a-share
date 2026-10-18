// TradingView-flavoured price chart renderer (candlesticks or a line/area).
//
// Deliberately dependency-free: a single canvas draw per state change, plus a
// lightweight crosshair overlay. Everything is fed by
// `/api/stocks/:code/analysis`, so the browser never recomputes indicators.

const UP = "#e5484d"; // 红涨
const DOWN = "#2f9e6f"; // 绿跌
const PALETTE = {
  light: {
    bg: "#ffffff",
    grid: "#eef1f6",
    axis: "#8b93a7",
    text: "#4b5567",
    band: "rgba(94,129,244,0.09)",
    bandLine: "rgba(94,129,244,0.5)",
    crosshair: "#9aa3b5",
    tooltipBg: "rgba(23,28,38,0.93)",
    tooltipText: "#f6f7fb",
    areaTop: "rgba(94,129,244,0.28)",
    areaBottom: "rgba(94,129,244,0.02)",
    lineStroke: "#3f8cff",
    divider: "#e7eaf1"
  },
  dark: {
    bg: "#141922",
    grid: "#222936",
    axis: "#7f8899",
    text: "#c3cad8",
    band: "rgba(120,150,255,0.11)",
    bandLine: "rgba(120,150,255,0.5)",
    crosshair: "#5c6678",
    tooltipBg: "rgba(240,243,250,0.94)",
    tooltipText: "#141922",
    areaTop: "rgba(120,150,255,0.32)",
    areaBottom: "rgba(120,150,255,0.02)",
    lineStroke: "#78a2ff",
    divider: "#232a36"
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

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{bars:Array, indicators:object, plan:object}} payload
 * @param {{range:number, overlays:Set<string>, hover:number|null, type:"candle"|"line"}} options
 */
export function drawPriceChart(canvas, payload, options = {}) {
  const colors = theme();
  const { ctx, width, height } = setupCanvas(canvas);
  const allBars = Array.isArray(payload?.bars) ? payload.bars : [];
  const indicators = payload?.indicators || {};
  const plan = payload?.plan || null;
  const overlays = options.overlays || new Set(["ma5", "ma10", "ma15", "ma20", "boll", "volume"]);
  const chartType = options.type === "line" ? "line" : "candle";

  // The visible slice is [from, to) over the full history, so the caller can
  // zoom and pan by moving that window instead of re-fetching anything.
  const total = allBars.length;
  const range = Math.max(Math.round(options.range || 120), 2);
  let from = Number.isInteger(options.from) ? options.from : Math.max(total - range, 0);
  let to = Number.isInteger(options.to) ? options.to : total;
  from = Math.min(Math.max(from, 0), Math.max(total - 2, 0));
  to = Math.min(Math.max(to, from + 2), total);
  const bars = allBars.slice(from, to);

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  if (bars.length === 0) return null;

  const padTop = 20;
  const padBottom = 28;
  const padRight = 66;
  const padLeft = 8;
  const showVolume = overlays.has("volume");
  const totalH = height - padTop - padBottom;
  const volumeH = showVolume ? Math.round(totalH * 0.2) : 0;
  const gap = showVolume ? 16 : 0;
  const priceH = totalH - volumeH - gap;
  const plotW = width - padLeft - padRight;
  const font = "-apple-system, 'Segoe UI', 'PingFang SC', sans-serif";

  // Indicator series arrive tail-aligned to the full history; realign to the window.
  const offset = (indicators.ma?.[5]?.length || total) - total + from;
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
  const span = max - min || Math.max(max * 0.02, 1);
  min -= span * 0.08;
  max += span * 0.08;

  const slot = plotW / bars.length;
  const xFor = (i) => padLeft + slot * (i + 0.5);
  const yFor = (price) => padTop + ((max - price) / (max - min)) * priceH;
  const volTop = padTop + priceH + gap;
  let volMax = 0;
  for (const bar of bars) volMax = Math.max(volMax, bar.volume || 0);
  const yVol = (volume) => volTop + volumeH - (volMax ? (volume / volMax) * volumeH : 0);

  // --- horizontal grid + price axis -----------------------------------------
  ctx.font = `11px ${font}`;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  const ticks = niceTicks(min, max, 5);
  for (const tick of ticks) {
    const y = Math.round(yFor(tick)) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.setLineDash([1, 3]);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.axis;
    ctx.textAlign = "left";
    ctx.fillText(tick >= 1000 ? tick.toFixed(0) : tick.toFixed(2), padLeft + plotW + 8, y);
  }

  // --- Bollinger channel ----------------------------------------------------
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

  const line = (series, color, dashed = false, lineWidth = 1.4) => {
    if (!Array.isArray(series)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
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

  // --- price series ---------------------------------------------------------
  const bodyW = Math.max(Math.min(slot * 0.66, 13), 1.2);
  if (chartType === "candle") {
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
  } else {
    // Line / area mode: a single smoothed close line with a soft gradient fill.
    const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + priceH);
    gradient.addColorStop(0, colors.areaTop);
    gradient.addColorStop(1, colors.areaBottom);
    ctx.beginPath();
    for (let i = 0; i < bars.length; i += 1) {
      const x = xFor(i);
      const y = yFor(bars[i].close);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const areaPath = new Path2D();
    areaPath.moveTo(xFor(0), yFor(bars[0].close));
    for (let i = 1; i < bars.length; i += 1) areaPath.lineTo(xFor(i), yFor(bars[i].close));
    const lastX = xFor(bars.length - 1);
    areaPath.lineTo(lastX, padTop + priceH);
    areaPath.lineTo(xFor(0), padTop + priceH);
    areaPath.closePath();
    ctx.fillStyle = gradient;
    ctx.fill(areaPath);

    ctx.strokeStyle = colors.lineStroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < bars.length; i += 1) {
      const x = xFor(i);
      const y = yFor(bars[i].close);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // --- volume pane ----------------------------------------------------------
  if (showVolume && volMax > 0) {
    ctx.strokeStyle = colors.divider;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, volTop - gap / 2);
    ctx.lineTo(padLeft + plotW, volTop - gap / 2);
    ctx.stroke();
    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      const up = bar.close >= bar.open;
      ctx.fillStyle = up ? "rgba(229,72,77,0.42)" : "rgba(47,158,111,0.42)";
      const x = xFor(i) - bodyW / 2;
      const y = yVol(bar.volume || 0);
      ctx.fillRect(x, y, bodyW, Math.max(volTop + volumeH - y, 0.6));
    }
    ctx.fillStyle = colors.axis;
    ctx.textAlign = "left";
    ctx.font = `10.5px ${font}`;
    ctx.fillText(formatVolume(volMax), padLeft + plotW + 8, volTop + 6);
  }

  // --- moving averages and bands -------------------------------------------
  if (overlays.has("boll")) {
    line(indicators.boll?.upper, colors.bandLine, true, 1);
    line(indicators.boll?.middle, colors.bandLine, false, 1);
    line(indicators.boll?.lower, colors.bandLine, true, 1);
  }
  for (const key of ["ma5", "ma10", "ma15", "ma20"]) {
    if (overlays.has(key)) line(indicators.ma?.[key.slice(2)], MA_COLORS[key.slice(2)], false, 1.5);
  }

  // --- last price marker (TradingView-style tag on the right axis) ----------
  ctx.font = `11px ${font}`;
  const lastBar = bars[bars.length - 1];
  const lastUp = lastBar.close >= bars[Math.max(bars.length - 2, 0)].close;
  const lastColor = lastUp ? UP : DOWN;
  const lastY = Math.round(yFor(lastBar.close)) + 0.5;
  ctx.strokeStyle = lastColor;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(padLeft, lastY);
  ctx.lineTo(padLeft + plotW, lastY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const tagText = lastBar.close.toFixed(2);
  ctx.font = `600 11px ${font}`;
  const tagW = ctx.measureText(tagText).width + 12;
  ctx.fillStyle = lastColor;
  roundRect(ctx, padLeft + plotW + 3, lastY - 8, tagW, 16, 3);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.fillText(tagText, padLeft + plotW + 9, lastY);

  // --- buy / stop / target markers -----------------------------------------
  // Every line carries its own price: three 买点 lines differ only by the level
  // they sit on, so "买点" alone leaves the reader guessing which is which.
  const labelYs = [];
  const marker = (price, color, label, dash) => {
    if (!Number.isFinite(price)) return;
    const y = Math.round(yFor(price)) + 0.5;
    if (y < padTop || y > padTop + priceH) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const text = `${label} ${price.toFixed(2)}`;
    ctx.font = `600 10.5px ${font}`;
    const textW = ctx.measureText(text).width;
    const x = padLeft + plotW - 6;
    // Stack labels that would otherwise be drawn on top of each other: prefer
    // sitting just above the line, drop below it when that spot is taken.
    let labelY = y - 6;
    for (const offset of [-6, 13, -19, 26]) {
      const candidate = y + offset;
      if (labelYs.every((used) => Math.abs(used - candidate) >= 11)) {
        labelY = candidate;
        break;
      }
    }
    labelYs.push(labelY);
    // A faint pill keeps the number readable where it crosses the candles.
    ctx.fillStyle = colors.bg;
    ctx.globalAlpha = 0.72;
    roundRect(ctx, x - textW - 4, labelY - 9, textW + 6, 13, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, labelY - 2);
    ctx.textBaseline = "alphabetic";
  };
  if (plan) {
    // "回踩 MA10 支撑" → "MA10", "布林带下轨超卖区" → "下轨": three buy zones at
    // three different levels read as one label otherwise.
    const zoneTag = (reason) => {
      const ma = /MA(\d+)/i.exec(reason || "");
      if (ma) return `MA${ma[1]}`;
      if (/下轨/.test(reason || "")) return "下轨";
      if (/上轨/.test(reason || "")) return "上轨";
      return "";
    };
    for (const zone of (plan.buyZones || []).slice(0, 3)) {
      const tag = zoneTag(zone.reason);
      marker(zone.price, "#3f8cff", tag ? `买点·${tag}` : "买点", [5, 4]);
    }
    marker(plan.stopLoss, DOWN, "止损", [2, 3]);
    marker(plan.target, UP, "目标", [2, 3]);
  }

  // --- date axis ------------------------------------------------------------
  ctx.fillStyle = colors.axis;
  ctx.font = `10.5px ${font}`;
  ctx.textAlign = "center";
  const labels = Math.min(bars.length, Math.max(Math.floor(plotW / 92), 2));
  for (let i = 0; i < labels; i += 1) {
    const index = Math.round((i * (bars.length - 1)) / Math.max(labels - 1, 1));
    ctx.fillText(bars[index].date.slice(5), xFor(index), height - padBottom / 2 - 1);
  }

  // --- crosshair + tooltip --------------------------------------------------
  const hover = options.hover;
  if (Number.isInteger(hover) && hover >= 0 && hover < bars.length) {
    const bar = bars[hover];
    const x = Math.round(xFor(hover)) + 0.5;
    ctx.strokeStyle = colors.crosshair;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
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
    ctx.fillStyle = colors.bg;
    ctx.fillRect(padLeft + plotW + 1, y - 8, padRight - 2, 16);
    ctx.fillStyle = colors.text;
    ctx.textAlign = "left";
    ctx.font = `600 11px ${font}`;
    ctx.fillText(bar.close.toFixed(2), padLeft + plotW + 8, y);

    const lines = [
      bar.date,
      `开 ${bar.open.toFixed(2)}   高 ${bar.high.toFixed(2)}`,
      `低 ${bar.low.toFixed(2)}   收 ${bar.close.toFixed(2)}`,
      `量 ${formatVolume(bar.volume)}`
    ];
    ctx.font = `11px ${font}`;
    const boxW = 152;
    const boxH = lines.length * 15 + 12;
    const boxX = Math.min(Math.max(x + 12, padLeft), padLeft + plotW - boxW);
    const boxY = padTop + 4;
    ctx.fillStyle = colors.tooltipBg;
    roundRect(ctx, boxX, boxY, boxW, boxH, 5);
    ctx.fill();
    ctx.fillStyle = colors.tooltipText;
    ctx.textAlign = "left";
    lines.forEach((text, index) => ctx.fillText(text, boxX + 9, boxY + 15 + index * 15));
  }

  return {
    bars,
    xFor,
    slot,
    offsetLeft: padLeft,
    count: bars.length,
    type: chartType,
    from,
    to,
    total,
    xToIndex: (x) => Math.min(Math.max(Math.floor((x - padLeft) / slot), 0), bars.length - 1)
  };
}

function formatVolume(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿手`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万手`;
  return `${Math.round(value)}手`;
}
