import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { SignalSummary } from '../services/signals-api.service';
import {
  chartHref,
  hasChecklistsCard,
  hasDetalleAdicional,
  hasMarketPlan,
  hasScoresCard,
  investorActionHint,
  investorPlanRows,
  investorRiskCard,
  investorScoreRows,
  investorScoresWaitTip,
  investorVerdictExplain,
  investorVerdictTitle,
  marketRows,
  riskGaugeHint,
  riskGaugeNeedle,
  scoreKpiRows,
  setupRows,
  verdictRows,
  verdictTone,
  biasTone,
  volMarkerPct,
} from './signal-report.helpers';

export type ReportViewMode = 'trader' | 'inversor' | 'rapida';

@Component({
  selector: 'app-signal-report-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './signal-report-viewer.component.html',
  styleUrl: './signal-report-viewer.component.scss',
})
export class SignalReportViewerComponent {
  @Input() summary: SignalSummary | null = null;
  @Input() mode: ReportViewMode = 'trader';
  @Input() preview: string | null = null;
  @Input() chartUrl: string | null = null;
  @Input() chartPath: string | null = null;
  /** Mercado para fallback del PNG si no hay chartUrl. */
  @Input() market = 'btc';

  readonly verdictRows = verdictRows;
  readonly marketRows = marketRows;
  readonly setupRows = setupRows;
  readonly scoreKpiRows = scoreKpiRows;
  readonly hasMarketPlan = hasMarketPlan;
  readonly hasScoresCard = hasScoresCard;
  readonly hasChecklistsCard = hasChecklistsCard;
  readonly hasDetalleAdicional = hasDetalleAdicional;
  readonly verdictTone = verdictTone;
  readonly investorVerdictTitle = investorVerdictTitle;
  readonly investorVerdictExplain = investorVerdictExplain;
  readonly investorActionHint = investorActionHint;
  readonly investorRiskCard = investorRiskCard;
  readonly investorScoreRows = investorScoreRows;
  readonly investorScoresWaitTip = investorScoresWaitTip;
  readonly investorPlanRows = investorPlanRows;
  readonly riskGaugeNeedle = riskGaugeNeedle;
  readonly riskGaugeHint = riskGaugeHint;
  readonly volMarkerPct = volMarkerPct;

  biasClass(campoOrValue: string | null | undefined, valor?: string | null): string {
    const isDireccion = valor !== undefined && /direcci[oó]n/i.test(campoOrValue || '');
    const raw = valor !== undefined ? valor : campoOrValue;
    const t = biasTone(raw);
    if (!t) return '';
    if (isDireccion || t === 'bullish' || t === 'bearish') return `bias-${t}`;
    return '';
  }

  /** Una sola evaluación de tone → clases (evita 4× verdictTone en el template). */
  verdictCellClass(valor: string | null | undefined): Record<string, boolean> {
    const t = verdictTone(valor);
    return {
      warn: t === 'warn',
      'ok-text': t === 'ok' || t === 'bullish',
      'bias-bearish': t === 'bearish',
      'bias-bullish': t === 'bullish',
    };
  }

  href(): string | null {
    return chartHref(this.market, this.chartUrl, this.chartPath);
  }
}
