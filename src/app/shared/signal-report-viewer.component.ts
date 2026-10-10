import { CommonModule } from '@angular/common';
import { Component, Input, inject } from '@angular/core';
import { DeviceService } from '../services/device.service';
import { DownloadService } from '../services/download.service';
import { HistoryMt5Real, SignalSummary } from '../services/signals-api.service';
import {
  chartHref,
  executionLevels,
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
  rapidaScoreGroups,
  ruleGradeClass,
  scoreKpiRows,
  setupRows,
  verdictRows,
  verdictSectionTone,
  verdictTone,
  displayScoreLabel,
  isCombinedScoreLabel,
  biasTone,
  volMarkerPct,
  type RapidaScoreGroup,
} from './signal-report.helpers';
import {
  INSTAGRAM_SIZES,
  downloadScoresImage,
  scoreImageFilename,
  statusMark,
  type InstagramFormat,
} from './score-image-export';
import { ZoomImageDirective } from './image-viewer/zoom-image.directive';

const INSTAGRAM_FORMAT_OPTIONS = (Object.keys(INSTAGRAM_SIZES) as InstagramFormat[]).map((id) => ({
  id,
  label: `${INSTAGRAM_SIZES[id].label} (${INSTAGRAM_SIZES[id].width}×${INSTAGRAM_SIZES[id].height})`,
}));

export type ReportViewMode = 'trader' | 'inversor' | 'rapida';

@Component({
  selector: 'app-signal-report-viewer',
  standalone: true,
  imports: [CommonModule, ZoomImageDirective],
  templateUrl: './signal-report-viewer.component.html',
  styleUrl: './signal-report-viewer.component.scss',
})
export class SignalReportViewerComponent {
  private readonly downloads = inject(DownloadService);
  /** En el WebView del APK «abrir en pestaña nueva» sustituiría la app: solo se ofrece descargar. */
  readonly isApk = inject(DeviceService).isApk;

  @Input() summary: SignalSummary | null = null;
  @Input() mode: ReportViewMode = 'trader';
  @Input() preview: string | null = null;
  @Input() chartUrl: string | null = null;
  @Input() chartPath: string | null = null;
  /** Mercado para fallback del PNG si no hay chartUrl. */
  @Input() market = 'btc';
  /** Ejecución real en MT5 (historial): el panel de niveles muestra lo ejecutado y el plan debajo. */
  @Input() execution: HistoryMt5Real | null = null;

  readonly executionLevels = executionLevels;
  readonly verdictRows = verdictRows;
  readonly marketRows = marketRows;
  readonly setupRows = setupRows;
  readonly scoreKpiRows = scoreKpiRows;
  readonly rapidaScoreGroups = rapidaScoreGroups;
  readonly hasMarketPlan = hasMarketPlan;
  readonly hasScoresCard = hasScoresCard;
  readonly hasChecklistsCard = hasChecklistsCard;
  readonly ruleGradeClass = ruleGradeClass;
  readonly hasDetalleAdicional = hasDetalleAdicional;
  readonly verdictTone = verdictTone;
  readonly verdictSectionTone = verdictSectionTone;
  readonly displayScoreLabel = displayScoreLabel;
  readonly isCombinedScoreLabel = isCombinedScoreLabel;
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
  readonly instagramFormats = INSTAGRAM_FORMAT_OPTIONS;
  readonly statusMark = statusMark;

  /** Guarda el PNG del gráfico (Descargas en el APK, descarga normal en el navegador). */
  downloadChart(href: string): void {
    void this.downloads.saveUrl(href);
  }

  async exportScoresImage(groups: RapidaScoreGroup[], format: InstagramFormat): Promise<void> {
    const s = this.summary;
    const market = (s?.market || this.market || 'btc').toUpperCase();
    const subtitle = [s?.verdict, s?.price ? `Precio ${s.price}` : '', s?.dataAsOf || '']
      .filter(Boolean)
      .join(' · ');
    const result = await downloadScoresImage(
      groups,
      {
        title: `${market} · Scores y confluencias`,
        subtitle,
        footer: 'Flash Signals · estimación estadística, no es asesoría financiera',
      },
      format,
      scoreImageFilename(market, format),
    );
    this.downloads.report(result);
  }

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
