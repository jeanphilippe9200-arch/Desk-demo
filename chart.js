/* Canvas charts: stack line, score ring, candles + volume. */

function _size(canvas) {
  if (!canvas) return null;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawLineChart(canvas, options) {
  const sized = _size(canvas);
  if (!sized) return;
  const { ctx, width, height } = sized;
  const points = (options.values || []).map((row, index) => {
    if (typeof row === "number") return { i: index, v: row };
    return { i: index, v: Number(row.value), ts: row.ts };
  }).filter((row) => Number.isFinite(row.v));
  if (!points.length) return;
  const nums = points.map((row) => row.v);
  const start = Number.isFinite(options.start) ? options.start : nums[0];
  const min = Math.min(...nums, start);
  const max = Math.max(...nums, start);
  const mid = (max + min) / 2;
  const span = Math.max(max - min, Math.abs(mid) * 0.02, 1e-9);
  const lo = mid - span / 2;
  const hi = mid + span / 2;
  const pad = { l: 8, r: 8, t: 10, b: 16 };
  const xAt = (index) => {
    if (points.length === 1) return width / 2;
    return pad.l + (index / (points.length - 1)) * (width - pad.l - pad.r);
  };
  const yAt = (value) => pad.t + (1 - (value - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const up = nums[nums.length - 1] >= start;
  const color = up ? "#30d158" : "#ff453a";

  ctx.beginPath();
  points.forEach((row, index) => {
    const x = xAt(index);
    const y = yAt(row.v);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineTo(xAt(points.length - 1), height - pad.b);
  ctx.lineTo(xAt(0), height - pad.b);
  ctx.closePath();
  const fade = ctx.createLinearGradient(0, pad.t, 0, height);
  fade.addColorStop(0, up ? "rgba(48,209,88,0.22)" : "rgba(255,69,58,0.18)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = fade;
  ctx.fill();

  const markEvery = Math.max(1, Math.ceil(points.length / 10));
  points.forEach((row, index) => {
    if (index % markEvery !== 0 && index !== points.length - 1) return;
    const x = xAt(index);
    const y = yAt(row.v);
    ctx.beginPath();
    ctx.arc(x, y, index === points.length - 1 ? 3.2 : 2.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "#000";
    ctx.stroke();
  });

  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, yAt(start));
  ctx.lineTo(width - pad.r, yAt(start));
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawScoreRing(canvas, score) {
  const sized = _size(canvas);
  if (!sized) return;
  const { ctx, width, height } = sized;
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2 - 6;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const color = value >= 70 ? "#30d158" : value >= 40 ? "#ffd60a" : "#ff453a";
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * value) / 100);
  ctx.stroke();
  ctx.fillStyle = "#f5f5f7";
  ctx.font = "600 22px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(Math.round(value)), cx, cy - 1);
}

function drawCandles(canvas, candles, options) {
  const sized = _size(canvas);
  if (!sized) return;
  const { ctx, width, height } = sized;
  const rows = (candles || []).filter((row) => Number.isFinite(Number(row.c)));
  if (!rows.length) {
    ctx.fillStyle = "#8e8e93";
    ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No price history yet", width / 2, height / 2);
    return;
  }
  const pad = { l: 8, r: 8, t: 8, b: 28 };
  const chartH = height - pad.t - pad.b;
  const volH = Math.max(22, chartH * 0.22);
  const priceH = chartH - volH - 8;
  const highs = rows.map((row) => Number(row.h ?? row.c));
  const lows = rows.map((row) => Number(row.l ?? row.c));
  const stop = (options && options.stop != null && options.stop !== "") ? Number(options.stop) : NaN;
  if (Number.isFinite(stop)) {
    highs.push(stop);
    lows.push(stop);
  }
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  if (max === min) {
    max += Math.abs(max) * 0.01 || 1e-9;
    min -= Math.abs(min) * 0.01 || 1e-9;
  }
  const vols = rows.map((row) => Number(row.v) || 0);
  const vmax = Math.max(...vols, 1);
  const gap = 2;
  const slot = (width - pad.l - pad.r) / rows.length;
  const body = Math.max(1.5, slot - gap);
  const xAt = (index) => pad.l + slot * index + slot / 2;
  const yAt = (price) => pad.t + (1 - (price - min) / (max - min)) * priceH;

  if (Number.isFinite(stop)) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#ff9f0a";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(pad.l, yAt(stop));
    ctx.lineTo(width - pad.r, yAt(stop));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  rows.forEach((row, index) => {
    const o = Number(row.o ?? row.c);
    const c = Number(row.c);
    const h = Number(row.h ?? row.c);
    const l = Number(row.l ?? row.c);
    const up = c >= o;
    const color = up ? "#30d158" : "#ff453a";
    const x = xAt(index);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yAt(h));
    ctx.lineTo(x, yAt(l));
    ctx.stroke();
    const top = yAt(Math.max(o, c));
    const bot = yAt(Math.min(o, c));
    ctx.fillStyle = color;
    ctx.fillRect(x - body / 2, top, body, Math.max(1, bot - top));
    if (vols[index]) {
      const vh = (vols[index] / vmax) * volH;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x - body / 2, height - pad.b - vh, body, vh);
      ctx.globalAlpha = 1;
    }
  });
}

function paintCharts() {
  document.querySelectorAll("canvas[data-chart]").forEach((canvas) => {
    const kind = canvas.dataset.chart;
    let payload = {};
    try { payload = JSON.parse(canvas.dataset.payload || "{}"); } catch { payload = {}; }
    if (kind === "line") drawLineChart(canvas, payload);
    else if (kind === "ring") drawScoreRing(canvas, payload.score);
    else if (kind === "candles") drawCandles(canvas, payload.candles || [], payload);
  });
}
