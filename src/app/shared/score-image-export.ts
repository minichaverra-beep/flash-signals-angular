/**
 * Exporta «Scores y confluencias» como PNG para Instagram (sin columna Detalle).
 * Dibujo directo en canvas: tamaño exacto y sin dependencias de captura de DOM.
 */
import type { DownloadResult } from './file-download';
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
const PAD = 64;
const VALUE_MAX_WIDTH = 260;

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

function statusColor(ok: boolean | null | undefined): string {
  if (ok === true) return COLORS.ok;
  if (ok === false) return COLORS.bad;
  return COLORS.info;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

interface TableLayout {
  width: number;
  rowH: number;
  groupH: number;
  fontSize: number;
  colStatus: number;
  colConcept: number;
  colValueRight: number;
}

/** Título y subtitulo; devuelve la y donde empieza la tabla. */
function drawHeader(ctx: CanvasRenderingContext2D, meta: ScoreImageMeta, width: number, top: number): number {
  let y = top;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 54px ${FONT}`;
  ctx.fillText(fitText(ctx, meta.title.toUpperCase(), width - PAD * 2), PAD, y);
  if (meta.subtitle) {
    y += 52;
    ctx.fillStyle = COLORS.muted;
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(fitText(ctx, meta.subtitle, width - PAD * 2), PAD, y);
  }
  return y + 48;
}

function tableLayout(lines: ImageLine[], width: number, available: number): TableLayout {
  const groupCount = lines.filter((l) => l.kind === 'group').length;
  const rowCount = lines.length - groupCount;
  const rowH = Math.max(52, Math.min(92, Math.floor(available / (rowCount + groupCount * 0.8 + 1))));
  return {
    width,
    rowH,
    groupH: Math.round(rowH * 0.8),
    fontSize: Math.round(rowH * 0.36),
    colStatus: PAD + 24,
    colConcept: PAD + 100,
    colValueRight: width - PAD - 24,
  };
}

/** Panel redondeado + cabecera de columnas; devuelve la y de la primera fila. */
function drawTableFrame(ctx: CanvasRenderingContext2D, lines: ImageLine[], t: TableLayout, top: number): number {
  const tableH = t.rowH + lines.reduce((h, l) => h + (l.kind === 'group' ? t.groupH : t.rowH), 0);
  ctx.fillStyle = COLORS.panel;
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(PAD, top, t.width - PAD * 2, tableH, 18);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = COLORS.gold;
  ctx.font = `700 ${Math.round(t.fontSize * 0.8)}px ${FONT}`;
  const headY = top + t.rowH * 0.62;
  ctx.fillText('ESTADO', t.colStatus - 8, headY);
  ctx.fillText('QUÉ SE MIDE', t.colConcept, headY);
  ctx.textAlign = 'right';
  ctx.fillText('VALOR', t.colValueRight, headY);
  ctx.textAlign = 'left';
  return top + t.rowH;
}

function drawGroupLine(ctx: CanvasRenderingContext2D, line: ImageLine, t: TableLayout, y: number): number {
  ctx.fillStyle = COLORS.gold;
  ctx.font = `700 ${Math.round(t.fontSize * 0.78)}px ${FONT}`;
  ctx.fillText(line.text, t.colStatus - 8, y + t.groupH * 0.68);
  return y + t.groupH;
}

function drawRowLine(ctx: CanvasRenderingContext2D, line: ImageLine, t: TableLayout, y: number): number {
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD + 12, y);
  ctx.lineTo(t.width - PAD - 12, y);
  ctx.stroke();

  const final = !!line.final;
  if (final) {
    ctx.fillStyle = 'rgba(245, 197, 66, 0.10)';
    ctx.fillRect(PAD + 2, y + 1, t.width - PAD * 2 - 4, t.rowH - 2);
  }
  const baseY = y + t.rowH * 0.64;
  ctx.fillStyle = statusColor(line.ok);
  ctx.font = `800 ${Math.round(t.fontSize * 1.15)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(statusMark(line.ok), t.colStatus + 26, baseY);

  ctx.textAlign = 'right';
  ctx.fillStyle = final ? COLORS.gold : COLORS.text;
  const valueSize = Math.round(t.fontSize * (final ? 1.25 : 1));
  ctx.font = `${final ? 800 : 600} ${valueSize}px ${FONT}`;
  const valor = fitText(ctx, line.valor || '—', VALUE_MAX_WIDTH);
  ctx.fillText(valor, t.colValueRight, baseY);
  const valueW = ctx.measureText(valor).width;

  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.text;
  ctx.font = `${final ? 700 : 500} ${t.fontSize}px ${FONT}`;
  ctx.fillText(fitText(ctx, line.text, t.colValueRight - valueW - 32 - t.colConcept), t.colConcept, baseY);
  return y + t.rowH;
}

function drawFooter(ctx: CanvasRenderingContext2D, meta: ScoreImageMeta, width: number, top: number): void {
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 26px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('✓ a favor · ✗ en contra · · informativo', width / 2, top + 56);
  if (meta.footer) {
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText(fitText(ctx, meta.footer, width - PAD * 2), width / 2, top + 96);
  }
  ctx.textAlign = 'left';
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

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const story = format === 'story';
  const footerSpace = story ? 200 : 120;
  const tableTop = drawHeader(ctx, meta, width, story ? 180 : 110);
  const lines = imageLines(groups);
  const layout = tableLayout(lines, width, height - tableTop - footerSpace);
  let y = drawTableFrame(ctx, lines, layout, tableTop);
  for (const line of lines) {
    y = line.kind === 'group' ? drawGroupLine(ctx, line, layout, y) : drawRowLine(ctx, line, layout, y);
  }
  drawFooter(ctx, meta, width, height - footerSpace);
  return canvas;
}

export function scoreImageFilename(market: string, format: InstagramFormat, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
  return `scores-${market.toLowerCase()}-${format}-${stamp}.png`;
}

export async function downloadScoresImage(
  groups: RapidaScoreGroup[],
  meta: ScoreImageMeta,
  format: InstagramFormat,
  filename: string,
): Promise<DownloadResult> {
  const canvas = renderScoresImage(groups, meta, format);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return { ok: false, via: 'none', filename, message: 'No se pudo generar la imagen' };
  // import() dinámico: este módulo se carga también en las pruebas con node (sin resolver «./file-download»).
  const { saveBlob } = await import('./file-download');
  return saveBlob(blob, filename);
}
