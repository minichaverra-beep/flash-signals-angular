/**
 * Writers de exportación del historial. Este módulo se importa con import() dinámico
 * desde el componente para que exceljs / jspdf solo se descarguen al exportar.
 */
import type { Borders, Cell, Fill, Worksheet } from 'exceljs';
import type { jsPDF as JsPdfDoc } from 'jspdf';
import type { CellHookData } from 'jspdf-autotable';
import {
  exportFileName,
  formatCell,
  formatDateTime,
  formatMoney,
  type CellValue,
  type ExportBundle,
  type ExportColumn,
  type ExportTable,
  type KpiTone,
} from './historial-export';
import { saveBlob, type DownloadResult } from '../../shared/file-download';

const BRAND = {
  fire: 'FF8C00',
  red: 'CD1818',
  gold: 'FFD700',
  teal: '116D6E',
  ok: '1E9E63',
  bad: 'D63B3B',
  warn: 'C98200',
  dark: '1A1010',
  darkSoft: '2A1A1A',
  ink: '221A1A',
  muted: '7A6A6A',
  stripe: 'FFF6EC',
  line: 'EBDCCB',
};

const DISCLAIMER =
  'Flash Signals · Historial local. No es consejo financiero: resultados pasados no garantizan resultados futuros.';

/** Guarda en Descargas (APK) o con la descarga del navegador; ver shared/file-download.ts. */
function downloadBlob(blob: Blob, fileName: string): Promise<DownloadResult> {
  return saveBlob(blob, fileName);
}

function toneColor(tone: KpiTone): string {
  if (tone === 'ok') return BRAND.ok;
  if (tone === 'bad') return BRAND.bad;
  if (tone === 'warn') return BRAND.warn;
  return BRAND.ink;
}

/** Color de texto según la pista de la columna (resultado / beneficio / tipo). */
function cellToneColor(col: ExportColumn, value: CellValue): string | null {
  if (!col.tone || value == null || value === '') return null;
  if (col.tone === 'profit' && typeof value === 'number') {
    if (value > 0) return BRAND.ok;
    if (value < 0) return BRAND.bad;
    return null;
  }
  if (col.tone === 'result') {
    if (value === 'Ganada') return BRAND.ok;
    if (value === 'Perdida') return BRAND.bad;
    if (value === 'No tomada') return BRAND.muted;
    return BRAND.warn;
  }
  if (col.tone === 'type') {
    if (value === 'buy') return BRAND.ok;
    if (value === 'sell') return BRAND.bad;
  }
  return null;
}

function subtitle(b: ExportBundle): string {
  const mode = b.mode === 'resumido' ? 'Resumido' : 'Detallado';
  return `Mercado: ${b.marketLabel} · Modo: ${mode} · ${b.scopeLabel} · ${b.table.rows.length} señales · Generado ${formatDateTime(b.generatedAt.toISOString())} (hora Colombia)`;
}

// ── Excel ────────────────────────────────────────────────────────────────────

const solid = (argb: string): Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${argb}` } });

const thinBorder: Partial<Borders> = {
  top: { style: 'thin', color: { argb: `FF${BRAND.line}` } },
  bottom: { style: 'thin', color: { argb: `FF${BRAND.line}` } },
  left: { style: 'thin', color: { argb: `FF${BRAND.line}` } },
  right: { style: 'thin', color: { argb: `FF${BRAND.line}` } },
};

function numFmt(col: ExportColumn): string | undefined {
  switch (col.kind) {
    case 'int':
      return '0';
    case 'money':
      return '+$#,##0.00;-$#,##0.00;$0.00';
    case 'percent':
      return '0.0"%"';
    case 'ratio':
      return '0.00';
    case 'number':
      return '#,##0.#####';
    case 'datetime':
      return 'yyyy.mm.dd hh:mm';
    default:
      return undefined;
  }
}

/** Fecha ISO → Date "de pared" en hora Colombia (Excel no guarda zona horaria). */
function excelDate(iso: string): Date | string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Date(d.getTime() - 5 * 60 * 60 * 1000);
}

function styleHeaderRow(ws: Worksheet, rowNumber: number, count: number): void {
  const row = ws.getRow(rowNumber);
  row.height = 22;
  for (let c = 1; c <= count; c++) {
    const cell = row.getCell(c);
    cell.fill = solid(BRAND.dark);
    cell.font = { bold: true, color: { argb: `FF${BRAND.gold}` }, size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  }
}

function writeValue(cell: Cell, col: ExportColumn, value: CellValue): void {
  if (value == null || value === '') {
    cell.value = col.kind === 'text' ? '' : '—';
    if (col.kind !== 'text') cell.alignment = { horizontal: 'center' };
    return;
  }
  if (col.kind === 'datetime' && typeof value === 'string') {
    cell.value = excelDate(value);
  } else {
    cell.value = value;
  }
  const fmt = numFmt(col);
  if (fmt && typeof cell.value !== 'string') cell.numFmt = fmt;
}

/** Escribe una tabla en la hoja a partir de startRow; devuelve la siguiente fila libre. */
function writeTable(ws: Worksheet, table: ExportTable, startRow: number, opts: { autoFilter?: boolean; freeze?: boolean } = {}): number {
  const { columns, rows } = table;
  const header = ws.getRow(startRow);
  columns.forEach((col, i) => {
    header.getCell(i + 1).value = col.header;
    const wsCol = ws.getColumn(i + 1);
    wsCol.width = Math.max(wsCol.width ?? 0, col.width);
  });
  styleHeaderRow(ws, startRow, columns.length);

  rows.forEach((r, ri) => {
    const row = ws.getRow(startRow + 1 + ri);
    columns.forEach((col, ci) => {
      const cell = row.getCell(ci + 1);
      const value = r[col.key] ?? null;
      writeValue(cell, col, value);
      cell.border = thinBorder;
      if (ri % 2 === 1) cell.fill = solid(BRAND.stripe);
      const color = cellToneColor(col, value);
      cell.font = { size: 10, color: { argb: `FF${color ?? BRAND.ink}` }, bold: !!color && col.tone !== 'type' };
      if (col.kind === 'text' && (col.key === 'comentario' || col.key === 'motivo' || col.key === 'confluencias')) {
        cell.alignment = { wrapText: true, vertical: 'top' };
      }
    });
  });

  const last = startRow + rows.length;
  if (opts.autoFilter && rows.length) {
    ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: last, column: columns.length } };
  }
  if (opts.freeze) {
    ws.views = [{ state: 'frozen', ySplit: startRow, xSplit: 0 }];
  }
  return last + 1;
}

function writeSheetTitle(ws: Worksheet, title: string, sub: string, span: number): number {
  ws.mergeCells(1, 1, 1, Math.max(span, 2));
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { bold: true, size: 16, color: { argb: `FF${BRAND.fire}` } };
  ws.getRow(1).height = 26;
  ws.mergeCells(2, 1, 2, Math.max(span, 2));
  const s = ws.getCell(2, 1);
  s.value = sub;
  s.font = { size: 10, italic: true, color: { argb: `FF${BRAND.muted}` } };
  return 4;
}

export async function exportHistoryExcel(bundle: ExportBundle): Promise<DownloadResult> {
  const ns = (await import('exceljs')) as unknown as typeof import('exceljs') & { default?: typeof import('exceljs') };
  const ExcelJS = ns.default ?? ns;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Flash Signals';
  wb.created = bundle.generatedAt;
  const sub = subtitle(bundle);

  // Resumen: KPIs + totales
  const summary = wb.addWorksheet('Resumen', { properties: { tabColor: { argb: `FF${BRAND.fire}` } } });
  let row = writeSheetTitle(summary, 'Flash Signals · Historial de señales', sub, 4);
  summary.getColumn(1).width = 26;
  summary.getColumn(2).width = 20;
  summary.getColumn(3).width = 38;
  ['Indicador', 'Valor', 'Detalle'].forEach((h, i) => (summary.getCell(row, i + 1).value = h));
  styleHeaderRow(summary, row, 3);
  row++;
  bundle.kpis.forEach((k, i) => {
    const r = summary.getRow(row + i);
    r.getCell(1).value = k.label;
    r.getCell(2).value = k.value;
    r.getCell(3).value = k.hint;
    r.getCell(1).font = { bold: true, size: 10, color: { argb: `FF${BRAND.ink}` } };
    r.getCell(2).font = { bold: true, size: 11, color: { argb: `FF${toneColor(k.tone)}` } };
    r.getCell(2).alignment = { horizontal: 'right' };
    r.getCell(3).font = { size: 9, color: { argb: `FF${BRAND.muted}` } };
    for (let c = 1; c <= 3; c++) {
      r.getCell(c).border = thinBorder;
      if (i % 2 === 1) r.getCell(c).fill = solid(BRAND.stripe);
    }
  });
  row += bundle.kpis.length + 1;
  const t = bundle.totals;
  const totalsRows: Array<[string, string | number]> = [
    ['Ganadas', t.ganadas],
    ['Perdidas', t.perdidas],
    ['No tomadas', t.noTomadas],
    ['Pendientes', t.pendientes],
    ['Beneficio total ($)', formatMoney(t.profit)],
  ];
  ['Totales', '', ''].forEach((h, i) => (summary.getCell(row, i + 1).value = h));
  styleHeaderRow(summary, row, 2);
  row++;
  totalsRows.forEach(([label, value], i) => {
    summary.getCell(row + i, 1).value = label;
    const v = summary.getCell(row + i, 2);
    v.value = value;
    v.alignment = { horizontal: 'right' };
    v.font = { bold: true, color: { argb: `FF${label.startsWith('Beneficio') ? toneColor(t.profit == null ? 'neutral' : t.profit >= 0 ? 'ok' : 'bad') : BRAND.ink}` } };
    summary.getCell(row + i, 1).border = thinBorder;
    v.border = thinBorder;
  });
  row += totalsRows.length + 1;
  summary.getCell(row, 1).value = DISCLAIMER;
  summary.getCell(row, 1).font = { italic: true, size: 9, color: { argb: `FF${BRAND.muted}` } };

  // Historial (según modo)
  const hist = wb.addWorksheet('Historial', { properties: { tabColor: { argb: `FF${BRAND.gold}` } } });
  const histStart = writeSheetTitle(hist, bundle.table.title, sub, bundle.table.columns.length);
  const next = writeTable(hist, bundle.table, histStart, { autoFilter: true, freeze: true });
  const profitIdx = bundle.table.columns.findIndex((c) => c.key === 'beneficio');
  if (profitIdx > 0) {
    const foot = hist.getRow(next);
    foot.getCell(1).value = `Ganadas ${t.ganadas} · Perdidas ${t.perdidas} · No tomadas ${t.noTomadas} · Pendientes ${t.pendientes}`;
    hist.mergeCells(next, 1, next, profitIdx);
    const total = foot.getCell(profitIdx + 1);
    total.value = t.profit ?? '—';
    if (t.profit != null) total.numFmt = numFmt(bundle.table.columns[profitIdx]) ?? '';
    for (let c = 1; c <= bundle.table.columns.length; c++) {
      const cell = foot.getCell(c);
      cell.fill = solid(BRAND.darkSoft);
      cell.font = { bold: true, color: { argb: `FF${BRAND.gold}` } };
      cell.border = thinBorder;
    }
    if (t.profit != null) total.font = { bold: true, color: { argb: `FF${t.profit >= 0 ? '3ECF8E' : 'FF8A8A'}` } };
  }

  // Desgloses
  for (const table of bundle.breakdowns) {
    const name = table.title.replace(/[\\/*?:[\]]/g, '').slice(0, 31);
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: `FF${BRAND.teal}` } } });
    const start = writeSheetTitle(ws, table.title, sub, table.columns.length);
    writeTable(ws, table, start, { autoFilter: true, freeze: true });
  }

  // Equity
  if (bundle.equity) {
    const ws = wb.addWorksheet('Equity', { properties: { tabColor: { argb: `FF${BRAND.ok}` } } });
    const start = writeSheetTitle(ws, bundle.equity.title, sub, bundle.equity.columns.length);
    writeTable(ws, bundle.equity, start, { freeze: true });
  }

  // Notas
  if (bundle.notes.length) {
    const ws = wb.addWorksheet('Notas');
    let r = writeSheetTitle(ws, 'Notas sobre los datos', sub, 2);
    ws.getColumn(1).width = 120;
    for (const n of bundle.notes) {
      const cell = ws.getCell(r++, 1);
      cell.value = `• ${n}`;
      cell.alignment = { wrapText: true };
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return downloadBlob(blob, exportFileName(bundle.mode, bundle.marketLabel, 'xlsx', bundle.generatedAt, bundle.fileTag));
}

// ── PDF ──────────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Helvetica (WinAnsi) no soporta emojis ni símbolos fuera de Latin-1. */
function pdfSafe(text: string): string {
  const allowed = new Set('—–‘’“”•…€'.split(''));
  return Array.from(text)
    .filter((ch) => (ch.codePointAt(0) ?? 0) <= 0xff || allowed.has(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadLogo(): Promise<string | null> {
  try {
    const res = await fetch('assets/logo.png');
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function lastTableY(doc: JsPdfDoc, fallback: number): number {
  return (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? fallback;
}

function drawHeader(doc: JsPdfDoc, bundle: ExportBundle, logo: string | null): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...rgb(BRAND.dark));
  doc.rect(0, 0, w, 26, 'F');
  doc.setFillColor(...rgb(BRAND.fire));
  doc.rect(0, 26, w, 1.2, 'F');
  let x = 12;
  if (logo) {
    doc.addImage(logo, 'PNG', 10, 4, 18, 18);
    x = 32;
  }
  doc.setTextColor(...rgb(BRAND.gold));
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text('FLASH SIGNALS · HISTORIAL DE SEÑALES', x, 13);
  doc.setTextColor(220, 210, 210);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(pdfSafe(subtitle(bundle)), x, 20);
  return 34;
}

function drawKpiCards(doc: JsPdfDoc, bundle: ExportBundle, top: number): number {
  const w = doc.internal.pageSize.getWidth();
  const margin = 10;
  const cols = 4;
  const gap = 4;
  const cardW = (w - margin * 2 - gap * (cols - 1)) / cols;
  const cardH = 17;
  const kpis = bundle.kpis.slice(0, 8);
  kpis.forEach((k, i) => {
    const cx = margin + (i % cols) * (cardW + gap);
    const cy = top + Math.floor(i / cols) * (cardH + gap);
    doc.setFillColor(...rgb(BRAND.stripe));
    doc.setDrawColor(...rgb(BRAND.line));
    doc.roundedRect(cx, cy, cardW, cardH, 2, 2, 'FD');
    doc.setFillColor(...rgb(toneColor(k.tone) === BRAND.ink ? BRAND.fire : toneColor(k.tone)));
    doc.rect(cx, cy + 2, 1.2, cardH - 4, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...rgb(BRAND.muted));
    doc.text(pdfSafe(k.label.toUpperCase()), cx + 4, cy + 5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...rgb(toneColor(k.tone)));
    doc.text(pdfSafe(k.value), cx + 4, cy + 11.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...rgb(BRAND.muted));
    doc.text(pdfSafe(k.hint), cx + 4, cy + 15);
  });
  return top + Math.ceil(kpis.length / cols) * (cardH + gap);
}

/** Barra apilada ganadas / perdidas / no tomadas / pendientes. */
function drawResultBar(doc: JsPdfDoc, bundle: ExportBundle, x: number, y: number, width: number): void {
  const t = bundle.totals;
  const parts: Array<[string, number, string]> = [
    ['Ganadas', t.ganadas, BRAND.ok],
    ['Perdidas', t.perdidas, BRAND.bad],
    ['No tomadas', t.noTomadas, '9A8C8C'],
    ['Pendientes', t.pendientes, BRAND.warn],
  ];
  const total = parts.reduce((s, p) => s + p[1], 0) || 1;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...rgb(BRAND.ink));
  doc.text('Distribución de resultados', x, y);
  let cx = x;
  const barY = y + 3;
  for (const [, n, color] of parts) {
    const segW = (n / total) * width;
    if (segW <= 0) continue;
    doc.setFillColor(...rgb(color));
    doc.rect(cx, barY, segW, 6, 'F');
    cx += segW;
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  let lx = x;
  for (const [label, n, color] of parts) {
    doc.setFillColor(...rgb(color));
    doc.rect(lx, barY + 9, 3, 3, 'F');
    doc.setTextColor(...rgb(BRAND.ink));
    const txt = `${label}: ${n} (${Math.round((n / total) * 100)}%)`;
    doc.text(txt, lx + 4.5, barY + 11.5);
    lx += doc.getTextWidth(txt) + 10;
  }
}

/** Curva de equity dibujada a mano (línea + área + línea de cero). */
function drawEquityChart(doc: JsPdfDoc, bundle: ExportBundle, x: number, y: number, w: number, h: number): void {
  const curve = bundle.equityCurve;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...rgb(BRAND.ink));
  const unit = bundle.pnlUnit === 'usd' ? '$' : 'R';
  doc.text(`Curva de equity (${unit})`, x, y);
  const top = y + 3;
  doc.setDrawColor(...rgb(BRAND.line));
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, top, w, h, 2, 2, 'FD');
  if (curve.length < 2) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...rgb(BRAND.muted));
    doc.text('Sin serie suficiente: marca resultado y $/PnL en las operaciones cerradas.', x + 4, top + h / 2);
    return;
  }
  const pts = [0, ...curve];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 4;
  const px = (i: number) => x + pad + (i / (pts.length - 1)) * (w - pad * 2);
  const py = (v: number) => top + h - pad - ((v - min) / span) * (h - pad * 2);

  const zeroY = py(0);
  doc.setDrawColor(...rgb(BRAND.muted));
  doc.setLineDashPattern([1, 1], 0);
  doc.setLineWidth(0.2);
  doc.line(x + pad, zeroY, x + w - pad, zeroY);
  doc.setLineDashPattern([], 0);

  const final = pts[pts.length - 1];
  const color = rgb(final >= 0 ? BRAND.ok : BRAND.bad);
  doc.setDrawColor(...color);
  doc.setLineWidth(0.6);
  for (let i = 1; i < pts.length; i++) {
    doc.line(px(i - 1), py(pts[i - 1]), px(i), py(pts[i]));
  }
  doc.setFillColor(...color);
  doc.circle(px(pts.length - 1), py(final), 0.9, 'F');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...rgb(BRAND.muted));
  const fmt = (v: number) => (bundle.pnlUnit === 'usd' ? formatMoney(v) : `${v.toFixed(2)} R`);
  doc.text(`máx ${fmt(max)}`, x + w - pad, top + 3.5, { align: 'right' });
  doc.text(`mín ${fmt(min)}`, x + w - pad, top + h - 1.2, { align: 'right' });
  doc.setTextColor(...color);
  doc.setFont('helvetica', 'bold');
  doc.text(`final ${fmt(final)}`, x + pad, top + 3.5);
}

function drawFooters(doc: JsPdfDoc): void {
  const pages = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...rgb(BRAND.fire));
    doc.setLineWidth(0.4);
    doc.line(10, h - 10, w - 10, h - 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...rgb(BRAND.muted));
    doc.text(pdfSafe(DISCLAIMER), 10, h - 6);
    doc.text(`Página ${i} de ${pages}`, w - 10, h - 6, { align: 'right' });
  }
}

export async function exportHistoryPdf(bundle: ExportBundle): Promise<DownloadResult> {
  const [{ jsPDF }, autoTableMod, logo] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    loadLogo(),
  ]);
  const autoTable = autoTableMod.autoTable;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 10;

  const tableFor = (table: ExportTable, startY: number, fontSize: number, extra: { title?: boolean } = {}) => {
    let y = startY;
    if (y > doc.internal.pageSize.getHeight() - 32) {
      doc.addPage();
      y = 16;
    }
    if (extra.title !== false) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...rgb(BRAND.fire));
      doc.text(pdfSafe(table.title.toUpperCase()), margin, y);
      y += 2;
    }
    const totalWeight = table.columns.reduce((s, c) => s + c.width, 0);
    const usable = pageW - margin * 2;
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin, bottom: 14, top: 14 },
      head: [table.columns.map((c) => pdfSafe(c.header))],
      body: table.rows.map((r) => table.columns.map((c) => pdfSafe(formatCell(r[c.key] ?? null, c.kind)))),
      theme: 'grid',
      styles: { fontSize, cellPadding: 1.4, textColor: rgb(BRAND.ink), lineColor: rgb(BRAND.line), lineWidth: 0.1, overflow: 'linebreak' },
      headStyles: { fillColor: rgb(BRAND.dark), textColor: rgb(BRAND.gold), fontStyle: 'bold', halign: 'center' },
      alternateRowStyles: { fillColor: rgb(BRAND.stripe) },
      columnStyles: Object.fromEntries(
        table.columns.map((c, i) => [
          i,
          {
            cellWidth: (c.width / totalWeight) * usable,
            halign: (c.kind === 'text' || c.kind === 'datetime' ? 'left' : 'right') as 'left' | 'right',
          },
        ])
      ),
      didParseCell: (data: CellHookData) => {
        if (data.section !== 'body') return;
        const col = table.columns[data.column.index];
        const raw = table.rows[data.row.index]?.[col.key] ?? null;
        const color = cellToneColor(col, raw);
        if (color) {
          data.cell.styles.textColor = rgb(color);
          if (col.tone !== 'type') data.cell.styles.fontStyle = 'bold';
        }
      },
    });
    return lastTableY(doc, y) + 8;
  };

  // Página 1: resumen visual
  let y = drawHeader(doc, bundle, logo);
  y = drawKpiCards(doc, bundle, y);
  const half = (pageW - margin * 2 - 6) / 2;
  drawResultBar(doc, bundle, margin, y + 2, half);
  drawEquityChart(doc, bundle, margin + half + 6, y + 2, half, 34);
  y += 44;

  // Segunda fila de KPIs en tabla compacta
  const rest = bundle.kpis.slice(8);
  if (rest.length) {
    y = tableFor(
      {
        title: 'Más indicadores',
        columns: [
          { key: 'label', header: 'Indicador', width: 24, kind: 'text' },
          { key: 'value', header: 'Valor', width: 14, kind: 'text' },
          { key: 'hint', header: 'Detalle', width: 40, kind: 'text' },
        ],
        rows: rest.map((k) => ({ label: k.label, value: k.value, hint: k.hint })),
      },
      y,
      7.5
    );
  }

  // Desgloses (analítica)
  for (const table of bundle.breakdowns) {
    y = tableFor(table, y, 7.5);
  }

  // Tabla principal en página nueva
  doc.addPage();
  y = tableFor(bundle.table, 16, bundle.mode === 'resumido' ? 7.5 : 6);
  const t = bundle.totals;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...rgb(BRAND.ink));
  const h = doc.internal.pageSize.getHeight();
  if (y > h - 20) {
    doc.addPage();
    y = 16;
  }
  doc.text(
    `Ganadas ${t.ganadas} · Perdidas ${t.perdidas} · No tomadas ${t.noTomadas} · Pendientes ${t.pendientes}`,
    margin,
    y - 3
  );
  doc.setTextColor(...rgb(t.profit == null ? BRAND.ink : t.profit >= 0 ? BRAND.ok : BRAND.bad));
  doc.text(`Beneficio total: ${formatMoney(t.profit)}`, pageW - margin, y - 3, { align: 'right' });

  drawFooters(doc);
  return downloadBlob(
    doc.output('blob'),
    exportFileName(bundle.mode, bundle.marketLabel, 'pdf', bundle.generatedAt, bundle.fileTag),
  );
}
