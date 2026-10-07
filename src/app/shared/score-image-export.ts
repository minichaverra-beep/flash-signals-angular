/**
 * Exporta «Scores y confluencias» como PNG para Instagram (sin columna Detalle).
 * Dibujo directo en canvas: tamaño exacto y sin dependencias de captura de DOM.
 */
import type { RapidaScoreGroup } from './signal-report.helpers';

export type InstagramFormat = 'post' | 'story';

export const INSTAGRAM_SIZES: Record<InstagramFormat, { width: number; height: number; label: string }> = {
  post: { width: 1080, height: 1350, label: 'Post 4:5' },
  story: { width: 1080, height: 1920, label: 'Historia 9:16' },
};

export interface ScoreImageMeta {
  title: string;
  subtitle?: string;
  footer?: string;
}

const COLORS = {
  bg: '#140c0c',
  panel: '#1e1414',
  border: '#3a2a1c',
  gold: '#f5c542',
  text: '#f2e9e4',
  muted: '#a8968a',
  ok: '#4ade80',
  bad: '#f87171',
  info: '#8a7a70',
};

const FONT = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Filas planas para la imagen: título de grupo o fila (estado, concepto, valor). */
export interface ImageLine {
  kind: 'group' | 'row';
  text: string;
  valor?: string;
  ok?: boolean | null;
  final?: boolean;
}

export function imageLines(groups: RapidaScoreGroup[]): ImageLine[] {
  const lines: ImageLine[] = [];
  for (const g of groups) {
    lines.push({ kind: 'group', text: g.titulo.toUpperCase() });
    for (const r of g.rows) {
      lines.push({ kind: 'row', text: r.concepto, valor: r.valor, ok: r.ok, final: r.final });
    }
  }
  return lines;
}

export function statusMark(ok: boolean | null | undefined): string {
  if (ok === true) return '✓';
  if (ok === false) return '✗';
  return '·';
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

export function renderScoresImage(
  groups: RapidaScoreGroup[],
  meta: ScoreImageMeta,
  format: InstagramFormat = 'post',
): HTMLCanvasElement {
  const { width, height } = INSTAGRAM_SIZES[format];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D no disponible');

  const pad = 64;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  // Cabecera
  let y = format === 'story' ? 180 : 110;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 54px ${FONT}`;
  ctx.fillText(fitText(ctx, meta.title.toUpperCase(), width - pad * 2), pad, y);
  if (meta.subtitle) {
    y += 52;
    ctx.fillStyle = COLORS.muted;
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(fitText(ctx, meta.subtitle, width - pad * 2), pad, y);
  }
  y += 48;

  const lines = imageLines(groups);
  const footerSpace = format === 'story' ? 200 : 120;
  const available = height - y - footerSpace;
  const groupCount = lines.filter((l) => l.kind === 'group').length;
  const rowCount = lines.length - groupCount;
  const rowH = Math.max(52, Math.min(92, Math.floor(available / (rowCount + groupCount * 0.8 + 1))));
  const groupH = Math.round(rowH * 0.8);
  const fontSize = Math.round(rowH * 0.36);

  // Encabezado de tabla
  const colStatus = pad + 24;
  const colConcept = pad + 100;
  const colValueRight = width - pad - 24;
  const valueMax = 260;

  ctx.fillStyle = COLORS.panel;
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  const tableH = rowH + rowCount * rowH + groupCount * groupH;
  ctx.beginPath();
  ctx.roundRect(pad, y, width - pad * 2, tableH, 18);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = COLORS.gold;
  ctx.font = `700 ${Math.round(fontSize * 0.8)}px ${FONT}`;
  const headY = y + rowH * 0.62;
  ctx.fillText('ESTADO', colStatus - 8, headY);
  ctx.fillText('QUÉ SE MIDE', colConcept, headY);
  ctx.textAlign = 'right';
  ctx.fillText('VALOR', colValueRight, headY);
  ctx.textAlign = 'left';
  y += rowH;

  for (const line of lines) {
    if (line.kind === 'group') {
      ctx.fillStyle = COLORS.gold;
      ctx.font = `700 ${Math.round(fontSize * 0.78)}px ${FONT}`;
      ctx.fillText(line.text, colStatus - 8, y + groupH * 0.68);
      y += groupH;
      continue;
    }
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad + 12, y);
    ctx.lineTo(width - pad - 12, y);
    ctx.stroke();

    if (line.final) {
      ctx.fillStyle = 'rgba(245, 197, 66, 0.10)';
      ctx.fillRect(pad + 2, y + 1, width - pad * 2 - 4, rowH - 2);
    }
    const baseY = y + rowH * 0.64;
    const color = line.ok === true ? COLORS.ok : line.ok === false ? COLORS.bad : COLORS.info;
    ctx.fillStyle = color;
    ctx.font = `800 ${Math.round(fontSize * 1.15)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(statusMark(line.ok), colStatus + 26, baseY);

    ctx.textAlign = 'right';
    ctx.fillStyle = line.final ? COLORS.gold : COLORS.text;
    ctx.font = `${line.final ? 800 : 600} ${Math.round(fontSize * (line.final ? 1.25 : 1))}px ${FONT}`;
    const valor = fitText(ctx, line.valor || '—', valueMax);
    ctx.fillText(valor, colValueRight, baseY);
    const valueW = ctx.measureText(valor).width;

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = `${line.final ? 700 : 500} ${fontSize}px ${FONT}`;
    ctx.fillText(fitText(ctx, line.text, colValueRight - valueW - 32 - colConcept), colConcept, baseY);
    y += rowH;
  }

  // Pie
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 26px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('✓ a favor · ✗ en contra · · informativo', width / 2, height - footerSpace + 56);
  if (meta.footer) {
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText(fitText(ctx, meta.footer, width - pad * 2), width / 2, height - footerSpace + 96);
  }
  ctx.textAlign = 'left';
  return canvas;
}

export function scoreImageFilename(market: string, format: InstagramFormat, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `scores-${market.toLowerCase()}-${format}-${stamp}.png`;
}

export function downloadScoresImage(
  groups: RapidaScoreGroup[],
  meta: ScoreImageMeta,
  format: InstagramFormat,
  filename: string,
): void {
  const canvas = renderScoresImage(groups, meta, format);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}
