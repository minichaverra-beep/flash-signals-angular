/**
 * Póster de la señal dibujado en canvas (una imagen, no una tabla HTML).
 * Solo pinta bloques que trae el summary. No inventa precios, minutos ni zonas.
 */
import {
  formatRiskNumber,
  riskFillPercent,
  type ShareAction,
  type ShareCardModel,
  type ShareDirection,
  type ShareLevel,
  type SharePill,
  type ShareScenario,
} from './signal-share-card.model';

const W = 1080;
const PAD = 44;
const GAP = 18;
const INNER = W - PAD * 2;

const C = {
  bg: '#101110',
  surface: '#181a19',
  border: '#343a36',
  text: '#f4fbf6',
  muted: '#8e9992',
  purple: '#4a33af',
  pink: '#f075c0',
  gain: '#3ecf8e',
  loss: '#f07171',
  amber: '#e7c56a',
};

const DISPLAY = '"Oswald", "Montserrat", "Segoe UI", sans-serif';
const BODY = '"Montserrat", "Segoe UI", system-ui, sans-serif';

const TITLE = `600 54px ${DISPLAY}`;
const KICKER = `700 15px ${BODY}`;
const PILL_TITLE = `700 28px ${BODY}`;
const PILL_DETAIL = `500 18px ${BODY}`;
const ACTION_TITLE = `700 34px ${DISPLAY}`;
const ACTION_REASON = `500 18px ${BODY}`;
const PRICE = `600 52px ${DISPLAY}`;
const PRICE_KICK = `700 15px ${BODY}`;
const ASOF = `500 18px ${BODY}`;
const TIER = `500 20px ${BODY}`;
const LEVEL_VALUE = `700 26px ${BODY}`;
const SCENARIO_TITLE = `700 20px ${BODY}`;
const BULLET = `500 18px ${BODY}`;
const FOOTER = `500 18px ${BODY}`;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PillBox extends Box {
  titleLines: string[];
  detailLines: string[];
}

interface LevelBox extends Box {
  valueLines: string[];
}

interface ScenarioBox extends Box {
  titleLines: string[];
  bullets: string[][];
}

interface PosterPlan {
  width: number;
  height: number;
  headerH: number;
  pills: PillBox[];
  action: Box | null;
  chart: { y: number; h: number } | null;
  oddsY: number;
  riskY: number;
  levelsLabelY: number;
  levels: LevelBox[];
  primary: ScenarioBox | null;
  pullback: ScenarioBox | null;
  footerY: number;
  footerLines: string[];
}

export function renderSharePoster(
  canvas: HTMLCanvasElement,
  card: ShareCardModel,
  chart: HTMLImageElement | null,
): void {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return;
  const plan = planPoster(probe, card, chart);
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  drawPoster(ctx, card, chart, plan);
}

function planPoster(ctx: CanvasRenderingContext2D, card: ShareCardModel, chart: HTMLImageElement | null): PosterPlan {
  let y = PAD;
  const headerH = measureHeader(ctx, card);
  if (headerH) y += headerH + GAP;

  const pills: PillBox[] = [];
  if (card.pills.length) {
    const n = card.pills.length;
    const gap = 14;
    const w = n === 1 ? Math.min(560, INNER) : (INNER - gap * (n - 1)) / n;
    const measured = card.pills.map((pill) => measurePill(ctx, pill, w));
    const h = Math.max(...measured.map((m) => m.h));
    card.pills.forEach((pill, i) => {
      pills.push({
        x: PAD + i * (w + gap),
        y,
        w,
        h,
        titleLines: measured[i].titleLines,
        detailLines: measured[i].detailLines,
      });
    });
    y += h + GAP;
  }

  const action = card.action ? { x: PAD, y, w: INNER, h: card.action.reason ? 96 : 72 } : null;
  if (action) y += action.h + GAP;

  let chartBox: { y: number; h: number } | null = null;
  if (chart && chart.naturalWidth > 0 && chart.naturalHeight > 0) {
    const raw = INNER * (chart.naturalHeight / chart.naturalWidth);
    const h = Math.round(Math.max(280, Math.min(820, raw)));
    chartBox = { y, h };
    y += h + GAP;
  }

  const oddsY = card.odds ? y : 0;
  if (card.odds) y += 156 + GAP;

  const riskY = card.risk != null ? y : 0;
  if (card.risk != null) y += (card.riskNote ? 168 : 118) + GAP;

  const levels: LevelBox[] = [];
  let levelsLabelY = 0;
  if (card.levels.length) {
    levelsLabelY = y;
    y += 32;
    const cols = levelColumnCount(card.levels);
    const gap = 12;
    const natural = (INNER - gap * (cols - 1)) / cols;
    const w = card.levels.length === 1 ? Math.min(320, natural) : natural;
    const rows: ShareLevel[][] = [];
    for (let i = 0; i < card.levels.length; i += cols) rows.push(card.levels.slice(i, i + cols));
    for (const row of rows) {
      const heights = row.map((level) => measureLevel(ctx, level, w).h);
      const h = Math.max(...heights);
      row.forEach((level, col) => {
        const measured = measureLevel(ctx, level, w);
        levels.push({ x: PAD + col * (w + gap), y, w, h, valueLines: measured.valueLines });
      });
      y += h + gap;
    }
    y = y - gap + GAP;
  }

  let primary: ScenarioBox | null = null;
  let pullback: ScenarioBox | null = null;
  if (card.primary || card.pullback) {
    const both = !!(card.primary && card.pullback);
    const gap = 14;
    const w = both ? (INNER - gap) / 2 : INNER;
    const pMeasured = card.primary ? measureScenario(ctx, card.primary, w) : null;
    const bMeasured = card.pullback ? measureScenario(ctx, card.pullback, w) : null;
    const h = Math.max(pMeasured?.h ?? 0, bMeasured?.h ?? 0);
    if (card.primary && pMeasured) {
      primary = { x: PAD, y, w, h, titleLines: pMeasured.titleLines, bullets: pMeasured.bullets };
    }
    if (card.pullback && bMeasured) {
      pullback = {
        x: both ? PAD + w + gap : PAD,
        y,
        w,
        h,
        titleLines: bMeasured.titleLines,
        bullets: bMeasured.bullets,
      };
    }
    y += h + GAP;
  }

  const footerLines = card.footer ? wrap(ctx, card.footer, INNER - 8, FOOTER) : [];
  const footerY = y;
  if (footerLines.length) y += footerLines.length * 26;

  if (y === PAD) y += 80;
  return {
    width: W,
    height: y + PAD,
    headerH,
    pills,
    action,
    chart: chartBox,
    oddsY,
    riskY,
    levelsLabelY,
    levels,
    primary,
    pullback,
    footerY,
    footerLines,
  };
}

function drawPoster(
  ctx: CanvasRenderingContext2D,
  card: ShareCardModel,
  chart: HTMLImageElement | null,
  plan: PosterPlan,
): void {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, plan.width, plan.height);
  ctx.fillStyle = C.purple;
  ctx.fillRect(0, 0, 8, plan.height);

  if (plan.headerH) drawHeader(ctx, card, PAD, plan.headerH);
  for (let i = 0; i < plan.pills.length; i++) drawPill(ctx, card.pills[i], plan.pills[i], card.direction);
  if (plan.action && card.action) drawAction(ctx, card.action, plan.action);
  if (plan.chart && chart) drawChart(ctx, chart, PAD, plan.chart.y, INNER, plan.chart.h);
  if (card.odds) drawOdds(ctx, card, plan.oddsY);
  if (card.risk != null) drawRiskBar(ctx, card.risk, card.riskFill, card.riskNote, plan.riskY);
  if (plan.levels.length) {
    ctx.fillStyle = C.pink;
    ctx.font = KICKER;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('NIVELES CLAVE', PAD, plan.levelsLabelY);
    plan.levels.forEach((box, i) => drawLevel(ctx, card.levels[i], box));
  }
  if (plan.primary && card.primary) drawScenario(ctx, card.primary, plan.primary);
  if (plan.pullback && card.pullback) drawScenario(ctx, card.pullback, plan.pullback);
  if (plan.footerLines.length) {
    ctx.fillStyle = C.muted;
    ctx.font = FOOTER;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    plan.footerLines.forEach((line, i) => ctx.fillText(line, PAD, plan.footerY + i * 26));
  }

  ctx.strokeStyle = C.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, plan.width - 2, plan.height - 2);
}

function measureHeader(ctx: CanvasRenderingContext2D, card: ShareCardModel): number {
  if (!card.symbol && !card.price && !card.tier && !card.timeframe) return 0;
  const symbolH = card.symbol || card.timeframe ? 62 : 0;
  const tierH = card.tier ? 28 : 0;
  const priceH = card.price ? 18 + 8 + 56 + (card.asOf ? 26 : 0) : 0;
  return Math.max(64, symbolH + tierH, priceH);
}

function drawHeader(ctx: CanvasRenderingContext2D, card: ShareCardModel, y: number, h: number): void {
  const markX = PAD;
  if (card.symbol || card.price) drawMark(ctx, markX, y + 4);

  const textX = card.symbol || card.price ? markX + 78 : PAD;
  let priceW = 0;
  if (card.price) {
    ctx.font = PRICE;
    priceW = Math.min(420, ctx.measureText(card.price).width + (card.direction ? 40 : 0));
  }
  const textMax = W - PAD - textX - (priceW ? priceW + 24 : 0);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  if (card.symbol || card.timeframe) {
    ctx.font = TITLE;
    const avail = Math.max(80, textMax);
    const sep = card.symbol && card.timeframe ? '  |  ' : '';
    let tfDraw = card.timeframe || '';
    if (tfDraw && ctx.measureText(`${card.symbol || ''}${sep}${tfDraw}`).width > avail) {
      tfDraw = fit(ctx, tfDraw, Math.min(140, avail * 0.4), TITLE);
    }
    const sepW = sep ? ctx.measureText(sep).width : 0;
    const tfW = tfDraw ? ctx.measureText(tfDraw).width : 0;
    const symbol = card.symbol ? fit(ctx, card.symbol, Math.max(40, avail - sepW - tfW), TITLE) : '';
    ctx.fillStyle = C.text;
    if (symbol) ctx.fillText(symbol, textX, y);
    const symW = symbol ? ctx.measureText(symbol).width : 0;
    if (sep) {
      ctx.fillStyle = C.muted;
      ctx.fillText(sep, textX + symW, y);
    }
    if (tfDraw) {
      ctx.fillStyle = C.pink;
      ctx.fillText(tfDraw, textX + symW + sepW, y);
    }
  }
  if (card.tier) {
    ctx.fillStyle = C.muted;
    ctx.font = TIER;
    ctx.fillText(fit(ctx, card.tier, textMax, TIER), textX, y + (card.symbol || card.timeframe ? 62 : 0));
  }

  if (card.price) {
    const right = W - PAD;
    ctx.textAlign = 'right';
    ctx.fillStyle = C.pink;
    ctx.font = PRICE_KICK;
    ctx.fillText('PRECIO ACTUAL', right, y);
    ctx.font = PRICE;
    ctx.fillStyle = C.text;
    const price = fit(ctx, card.price, 420, PRICE);
    const pw = ctx.measureText(price).width;
    ctx.fillText(price, right, y + 26);
    if (card.direction) drawChevron(ctx, right - pw - 34, y + 42, card.direction === 'Alcista');
    if (card.asOf) {
      ctx.fillStyle = C.muted;
      ctx.font = ASOF;
      ctx.fillText(fit(ctx, card.asOf, 460, ASOF), right, y + 86);
    }
    ctx.textAlign = 'left';
  }

  if (h > 0) {
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y + h + 2);
    ctx.lineTo(W - PAD, y + h + 2);
    ctx.stroke();
  }
}

function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const bars = [
    { w: 52, color: C.purple },
    { w: 38, color: C.pink },
    { w: 24, color: C.purple },
  ];
  bars.forEach((bar, i) => {
    ctx.fillStyle = bar.color;
    roundRect(ctx, x, y + i * 18, bar.w, 12, 4);
    ctx.fill();
  });
}

function drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, up: boolean): void {
  ctx.fillStyle = up ? C.gain : C.loss;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y + 16);
    ctx.lineTo(x + 11, y);
    ctx.lineTo(x + 22, y + 16);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + 11, y + 16);
    ctx.lineTo(x + 22, y);
  }
  ctx.closePath();
  ctx.fill();
}

function measurePill(ctx: CanvasRenderingContext2D, pill: SharePill, w: number): { h: number; titleLines: string[]; detailLines: string[] } {
  const textW = w - 108;
  const titleLines = wrap(ctx, pill.title, textW, PILL_TITLE);
  const detailLines = pill.detail ? wrap(ctx, pill.detail, textW, PILL_DETAIL) : [];
  const textH = titleLines.length * 34 + (detailLines.length ? 8 + detailLines.length * 24 : 0);
  return { h: Math.max(108, 28 + textH + 16), titleLines, detailLines };
}

function drawPill(ctx: CanvasRenderingContext2D, pill: SharePill, box: PillBox, direction: ShareDirection | null): void {
  panel(ctx, box, C.border);
  const icon = pillIcon(pill.kicker);
  drawPillIcon(ctx, box.x + 18, box.y + 22, icon, direction);
  const x = box.x + 84;
  let y = box.y + 18;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  if (pill.kicker.trim()) {
    ctx.fillStyle = C.pink;
    ctx.font = KICKER;
    ctx.fillText(fit(ctx, pill.kicker.toUpperCase(), box.w - 100, KICKER), x, y);
    y += 24;
  }
  ctx.fillStyle = C.text;
  ctx.font = PILL_TITLE;
  for (const line of box.titleLines) {
    ctx.fillText(line, x, y);
    y += 34;
  }
  ctx.fillStyle = C.muted;
  ctx.font = PILL_DETAIL;
  for (const line of box.detailLines) {
    ctx.fillText(line, x, y);
    y += 24;
  }
}

function drawAction(ctx: CanvasRenderingContext2D, action: ShareAction, box: Box): void {
  const accent = action.state === 'TOMAR' ? C.gain : C.amber;
  panel(ctx, box, accent);
  ctx.fillStyle = accent;
  ctx.fillRect(box.x + 10, box.y + 14, 8, box.h - 28);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = ACTION_TITLE;
  ctx.fillText(action.state, box.x + 32, box.y + 16);
  if (action.reason) {
    ctx.fillStyle = C.text;
    ctx.font = ACTION_REASON;
    ctx.fillText(fit(ctx, action.reason, box.w - 56, ACTION_REASON), box.x + 32, box.y + 58);
  }
}

function pillIcon(kicker: string): 'trend' | 'target' | 'prob' {
  if (/tendencia/i.test(kicker)) return 'trend';
  if (/probabilidad/i.test(kicker)) return 'prob';
  return 'target';
}

function drawPillIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: 'trend' | 'target' | 'prob',
  direction: ShareDirection | null,
): void {
  ctx.strokeStyle = C.purple;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x + 22, y + 22, 22, 0, Math.PI * 2);
  ctx.stroke();
  if (kind === 'trend') {
    if (!direction) {
      ctx.fillStyle = C.muted;
      ctx.fillRect(x + 12, y + 20, 20, 4);
      return;
    }
    drawChevron(ctx, x + 11, y + 14, direction === 'Alcista');
    return;
  }
  ctx.fillStyle = C.pink;
  if (kind === 'prob') {
    ctx.font = `700 16px ${BODY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('%', x + 22, y + 23);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    return;
  }
  ctx.beginPath();
  ctx.arc(x + 22, y + 22, 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + 22, y + 22, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function measureLevel(ctx: CanvasRenderingContext2D, level: ShareLevel, w: number): { h: number; valueLines: string[] } {
  const valueLines = wrap(ctx, level.value, w - 28, LEVEL_VALUE);
  return { h: 22 + 20 + valueLines.length * 32 + 16, valueLines };
}

function drawLevel(ctx: CanvasRenderingContext2D, level: ShareLevel, box: LevelBox): void {
  panel(ctx, box, C.border);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.pink;
  ctx.font = KICKER;
  ctx.fillText(fit(ctx, level.label.toUpperCase(), box.w - 28, KICKER), box.x + 14, box.y + 16);
  ctx.fillStyle = level.tone === 'gain' ? C.gain : level.tone === 'loss' ? C.loss : C.text;
  ctx.font = LEVEL_VALUE;
  box.valueLines.forEach((line, i) => ctx.fillText(line, box.x + 14, box.y + 42 + i * 32));
}

function measureScenario(
  ctx: CanvasRenderingContext2D,
  box: ShareScenario,
  w: number,
): { h: number; titleLines: string[]; bullets: string[][] } {
  const titleLines = wrap(ctx, box.title.toUpperCase(), w - 36, SCENARIO_TITLE);
  const bullets = box.bullets.map((line) => wrap(ctx, line, w - 58, BULLET));
  let h = 20 + titleLines.length * 28 + 8;
  for (const lines of bullets) h += lines.length * 26 + 8;
  return { h: h + 14, titleLines, bullets };
}

function drawScenario(ctx: CanvasRenderingContext2D, scenario: ShareScenario, box: ScenarioBox): void {
  const tone = scenario.tone === 'loss' ? C.loss : C.gain;
  panel(ctx, box, tone);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = tone;
  ctx.font = SCENARIO_TITLE;
  let y = box.y + 16;
  for (const line of box.titleLines) {
    ctx.fillText(line, box.x + 16, y);
    y += 28;
  }
  y += 4;
  ctx.font = BULLET;
  ctx.fillStyle = C.text;
  for (const lines of box.bullets) {
    ctx.fillStyle = tone;
    ctx.fillText('✓', box.x + 16, y);
    ctx.fillStyle = C.text;
    lines.forEach((line, li) => {
      ctx.fillText(line, box.x + 38, y + li * 26);
    });
    y += lines.length * 26 + 8;
  }
}

function drawOdds(ctx: CanvasRenderingContext2D, card: ShareCardModel, y: number): void {
  const odds = card.odds;
  if (!odds) return;
  const box = { x: PAD, y, w: INNER, h: 156 };
  panel(ctx, box, C.border);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.text;
  ctx.font = `700 22px ${BODY}`;
  const head = oddsTitle(card);
  ctx.fillText(fit(ctx, head, INNER - 36, `700 22px ${BODY}`), PAD + 18, y + 16);
  drawOddsRow(ctx, 'COMPRA', odds.compra, C.gain, PAD + 18, y + 58, INNER - 36);
  drawOddsRow(ctx, 'VENTA', odds.venta, C.loss, PAD + 18, y + 104, INNER - 36);
}

function oddsTitle(card: ShareCardModel): string {
  const pair = [card.symbol, card.timeframe].filter(Boolean).join(' · ');
  return pair ? `${pair} | Probabilidad estimada` : 'Probabilidad estimada';
}

function drawOddsRow(
  ctx: CanvasRenderingContext2D,
  label: string,
  pct: number,
  color: string,
  x: number,
  y: number,
  width: number,
): void {
  ctx.font = `700 18px ${BODY}`;
  ctx.fillStyle = C.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 12);
  const labelW = 108;
  const pctText = `${pct}%`;
  ctx.font = `700 20px ${BODY}`;
  const pctW = ctx.measureText(pctText).width;
  const barX = x + labelW;
  const barW = Math.max(40, width - labelW - pctW - 16);
  const barH = 14;
  const barY = y + 5;
  ctx.fillStyle = '#1e2220';
  roundRect(ctx, barX, barY, barW, barH, 7);
  ctx.fill();
  const fillW = Math.max(0, Math.min(barW, (barW * pct) / 100));
  if (fillW > 0) {
    ctx.save();
    roundRect(ctx, barX, barY, barW, barH, 7);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(barX, barY, fillW, barH);
    ctx.restore();
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'right';
  ctx.fillText(pctText, x + width, y + 13);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

function drawRiskBar(
  ctx: CanvasRenderingContext2D,
  points: number,
  fillPct: number | null,
  note: string | null,
  y: number,
): void {
  const box = { x: PAD, y, w: INNER, h: note ? 168 : 118 };
  panel(ctx, box, C.border);
  const fill = fillPct == null ? 0 : riskFillPercent(fillPct);
  const value = `${formatRiskNumber(points)} pts`;
  const x = PAD + 18;
  const width = INNER - 36;
  const rowY = y + 28;
  ctx.font = `700 22px ${BODY}`;
  ctx.fillStyle = C.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Riesgo', x, rowY + 22);
  ctx.font = `700 26px ${BODY}`;
  const valueW = ctx.measureText(value).width;
  const labelW = 128;
  const barX = x + labelW;
  const barW = Math.max(40, width - labelW - valueW - 20);
  const barH = 36;
  const barY = rowY + 4;
  ctx.fillStyle = '#1e2220';
  roundRect(ctx, barX, barY, barW, barH, 18);
  ctx.fill();
  const fillW = Math.max(0, Math.min(barW, (barW * fill) / 100));
  if (fillW > 0) {
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    grad.addColorStop(0, C.gain);
    grad.addColorStop(0.45, '#e7c56a');
    grad.addColorStop(0.78, C.loss);
    grad.addColorStop(1, '#cd1818');
    ctx.save();
    roundRect(ctx, barX, barY, barW, barH, 18);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, fillW, barH);
    ctx.restore();
  }
  if (fillPct != null) {
    const markerX = barX + Math.max(14, Math.min(barW - 14, fillW));
    ctx.beginPath();
    ctx.arc(markerX, barY + barH / 2, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#f4fbf6';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = riskTone(fill);
    ctx.stroke();
  }
  ctx.fillStyle = riskTone(fill);
  ctx.textAlign = 'right';
  ctx.fillText(value, x + width, rowY + 22);
  if (note) {
    ctx.font = `500 20px ${BODY}`;
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(note, x, y + 132);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

function riskTone(fill: number): string {
  if (fill < 40) return C.gain;
  if (fill < 70) return '#e7c56a';
  return C.loss;
}

function drawChart(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.save();
  roundRect(ctx, x, y, w, h, 16);
  ctx.clip();
  ctx.fillStyle = C.surface;
  ctx.fillRect(x, y, w, h);
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
  roundRect(ctx, x, y, w, h, 16);
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function levelColumnCount(levels: ShareLevel[]): number {
  const long = levels.some((level) => level.value.length > 18);
  const max = long ? 3 : Math.min(5, levels.length);
  return Math.max(1, Math.min(max, levels.length));
}

function panel(ctx: CanvasRenderingContext2D, box: Box, stroke: string): void {
  roundRect(ctx, box.x, box.y, box.w, box.h, 14);
  ctx.fillStyle = C.surface;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, font: string): string[] {
  ctx.font = font;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    for (const part of splitLong(ctx, word, maxW)) {
      const next = cur ? `${cur} ${part}` : part;
      if (cur && ctx.measureText(next).width > maxW) {
        lines.push(cur);
        cur = part;
      } else {
        cur = next;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function splitLong(ctx: CanvasRenderingContext2D, word: string, maxW: number): string[] {
  if (ctx.measureText(word).width <= maxW) return [word];
  const out: string[] = [];
  let buf = '';
  for (const ch of word) {
    if (buf && ctx.measureText(buf + ch).width > maxW) {
      out.push(buf);
      buf = ch;
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number, font: string): string {
  ctx.font = font;
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
