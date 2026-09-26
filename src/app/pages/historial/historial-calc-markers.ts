/**
 * Barras de cambio de cálculo en el grid del historial.
 * Señales con createdAt >= marker.createdAt quedan ENCIMA de la barra.
 */
export interface CalcMarkerLike {
  id: number;
  createdAt: string;
  title: string;
  comment?: string | null;
  market?: string | null;
}

export interface HistItemLike {
  id: number;
  createdAt: string;
}

export type HistDisplayRow<TItem extends HistItemLike = HistItemLike> =
  | { kind: 'signal'; item: TItem; key: string }
  | { kind: 'calc_marker'; marker: CalcMarkerLike; key: string };

/** Mezcla señales + marcadores por createdAt (nuevas arriba de la barra). */
export function mergeCalcMarkersIntoRows<TItem extends HistItemLike>(
  items: TItem[],
  markers: CalcMarkerLike[],
  opts: { isLastPage?: boolean } = {}
): HistDisplayRow<TItem>[] {
  const sorted = [...(markers || [])].sort((a, b) => {
    const c = String(b.createdAt).localeCompare(String(a.createdAt));
    return c !== 0 ? c : b.id - a.id;
  });
  const rows: HistDisplayRow<TItem>[] = [];
  let mi = 0;
  for (const item of items) {
    const itemAt = String(item.createdAt || '');
    while (mi < sorted.length && String(sorted[mi].createdAt) >= itemAt) {
      const m = sorted[mi++];
      rows.push({ kind: 'calc_marker', marker: m, key: `m-${m.id}` });
    }
    rows.push({ kind: 'signal', item, key: `s-${item.id}` });
  }
  if (opts.isLastPage) {
    while (mi < sorted.length) {
      const m = sorted[mi++];
      rows.push({ kind: 'calc_marker', marker: m, key: `m-${m.id}` });
    }
  }
  return rows;
}
