/**
 * Spec ligera: construcción de params de historyList (sin TestBed/HTTP real).
 * Valida el contrato de query que usa el historial de la página /senales.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Réplica pura de la lógica de params de SignalsApiService.historyList */
function historyListParams(opts: {
  page?: number;
  pageSize?: number;
  market?: 'btc' | 'us30' | 'xauusd' | '';
} = {}): Record<string, string> {
  const params: Record<string, string> = {
    page: String(opts.page ?? 1),
    pageSize: String(opts.pageSize ?? 20),
  };
  if (opts.market) params['market'] = opts.market;
  return params;
}

describe('SignalsApiService historyList params', () => {
  it('defaults page=1 pageSize=20 sin market', () => {
    assert.deepEqual(historyListParams(), {
      page: '1',
      pageSize: '20',
    });
  });

  it('incluye market solo si hay valor', () => {
    assert.deepEqual(historyListParams({ market: '' }), {
      page: '1',
      pageSize: '20',
    });
    assert.deepEqual(historyListParams({ page: 2, pageSize: 10, market: 'btc' }), {
      page: '2',
      pageSize: '10',
      market: 'btc',
    });
  });
});
