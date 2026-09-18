import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type Market = 'btc' | 'us30';
export type Tier = 'context' | 'light' | 'high' | 'history';

export interface RunRequest {
  market: Market;
  tier: Tier;
  bullish?: boolean;
  bearish?: boolean;
  breakSetup?: boolean;
  reverse?: boolean;
  ml?: boolean;
  neural?: boolean;
  ilustrate?: boolean;
  advanced?: boolean;
  noChart?: boolean;
  noOpen?: boolean;
  entry?: string;
}

export interface ChecklistItem {
  label: string;
  ok: boolean | null;
  note?: string;
}

export interface PlanDetails {
  entry?: string | null;
  sl?: string | null;
  tp?: string | null;
  rr?: string | null;
  risk?: string | null;
  trigger?: string | null;
  invalidation?: string | null;
  confirmation?: string | null;
}

export interface ScoreBar {
  label: string;
  value: number | null;
  raw?: string;
  weight?: string;
  note?: string;
}

export interface VolumeInfo {
  band?: string | null;
  ratio?: number | null;
  preset?: string | null;
  thresholds?: {
    very_low?: number | null;
    low?: number | null;
    high?: number | null;
    extreme?: number | null;
  } | null;
}

export interface SignalSummary {
  market?: string;
  tier?: string;
  verdict?: string | null;
  plan?: string | null;
  twoM5?: string | null;
  redFlags?: string[];
  price?: string | null;
  entryOptima?: string | null;
  bias?: string | null;
  setup?: string | null;
  impulso?: string | null;
  winrate?: string | null;
  rulesPct?: number | null;
  mlPct?: number | null;
  confluencePct?: number | null;
  confluenceLabel?: string | null;
  scoreExtended?: number | null;
  scoreCombined?: number | null;
  planDetails?: PlanDetails | null;
  checklist2M5?: ChecklistItem[];
  checklistE1?: ChecklistItem[];
  scorecard?: ScoreBar[];
  chartScores?: ScoreBar[];
  volume?: VolumeInfo | null;
  zentinel?: {
    killzone?: string | null;
    watchtowerKz?: string | null;
    volBand?: string | null;
    volRatio?: number | null;
    preset?: string | null;
    kzOn?: boolean | null;
    note?: string;
  };
}

export interface JobStatus {
  status: 'idle' | 'running' | 'done' | 'error' | string;
  startedAt?: string;
  finishedAt?: string;
  market?: string;
  tier?: string;
  command?: string;
  exitCode?: number | null;
  logs: string[];
  error?: string | null;
  reportPath?: string | null;
  summary?: SignalSummary | null;
}

export interface LatestResponse {
  reportPath: string;
  reportName: string;
  chartPath?: string | null;
  chartUrl?: string | null;
  mtime: string;
  summary: SignalSummary | null;
  preview: string;
}

@Injectable({ providedIn: 'root' })
export class SignalsApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  health(): Observable<{ ok: boolean; tradingRoot: string; tradingRootExists: boolean }> {
    return this.http.get<{ ok: boolean; tradingRoot: string; tradingRootExists: boolean }>(
      `${this.base}/health`
    );
  }

  run(body: RunRequest): Observable<{ message: string; job: Partial<JobStatus> }> {
    return this.http.post<{ message: string; job: Partial<JobStatus> }>(
      `${this.base}/signals/run`,
      body
    );
  }

  status(): Observable<JobStatus> {
    return this.http.get<JobStatus>(`${this.base}/signals/status`);
  }

  latest(market: Market, tier: Tier = 'high'): Observable<LatestResponse> {
    return this.http.get<LatestResponse>(
      `${this.base}/signals/latest`,
      { params: { market, tier } }
    );
  }

  zentinel(market: Market): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(`${this.base}/zentinel`, {
      params: { market },
    });
  }
}
