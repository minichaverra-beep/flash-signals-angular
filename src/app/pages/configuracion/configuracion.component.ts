import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  Mt5Health,
  Mt5ProfileId,
  Mt5Settings,
  Mt5SettingsPatch,
  Mt5SettingsState,
  Mt5SignalMarket,
  SignalsApiService,
} from '../../services/signals-api.service';

type LotMode = 'risk' | 'fixed';

/** Borrador editable de un perfil (los cambios no se aplican hasta Guardar). */
interface ProfileDraft {
  form: Mt5Settings;
  lotMode: LotMode;
  fixedVolume: number | null;
  tokenInput: string;
  clearToken: boolean;
}

const PROFILE_IDS: Mt5ProfileId[] = ['principal', 'secundaria'];

@Component({
  selector: 'app-configuracion',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RouterLinkActive],
  templateUrl: './configuracion.component.html',
  styleUrl: './configuracion.component.scss',
})
export class ConfiguracionComponent implements OnInit, OnDestroy {
  private readonly api = inject(SignalsApiService);

  readonly profileIds = PROFILE_IDS;
  readonly markets: { id: Mt5SignalMarket; label: string; hint: string }[] = [
    { id: 'btc', label: 'BTC', hint: 'ej. BTCUSD, BTCUSD.m' },
    { id: 'us30', label: 'US30', hint: 'ej. US30, US30.cash, DJ30' },
    { id: 'xauusd', label: 'XAUUSD', hint: 'ej. XAUUSD, XAUUSDm, GOLD' },
  ];

  state: Mt5SettingsState | null = null;
  drafts: Partial<Record<Mt5ProfileId, ProfileDraft>> = {};
  editing: Mt5ProfileId = 'principal';

  loading = true;
  saving = false;
  switching = false;
  message = '';
  messageErr = false;
  private messageTimer: ReturnType<typeof setTimeout> | null = null;

  health: Mt5Health | null = null;
  testing = false;

  /** Perfil cuyo borrador espera confirmación para activar reversiones. */
  reversalConfirm: Mt5ProfileId | null = null;
  private reversalTrigger: HTMLElement | null = null;

  ngOnInit(): void {
    this.load();
  }

  ngOnDestroy(): void {
    if (this.messageTimer) clearTimeout(this.messageTimer);
  }

  get draft(): ProfileDraft | null {
    return this.drafts[this.editing] ?? null;
  }

  label(id: Mt5ProfileId): string {
    return this.state?.labels[id] ?? id;
  }

  get otherProfile(): Mt5ProfileId {
    return this.editing === 'principal' ? 'secundaria' : 'principal';
  }

  load(): void {
    this.loading = true;
    this.message = '';
    this.api.mt5Settings().subscribe({
      next: (s) => {
        this.loading = false;
        this.state = s;
        for (const id of PROFILE_IDS) this.drafts[id] = this.toDraft(s.profiles[id]);
        this.editing = s.active;
        this.health = null;
      },
      error: (err: unknown) => {
        this.loading = false;
        this.showMessage(this.errMsg(err, 'No se pudo leer la configuración (¿API arrancada?).'), true);
      },
    });
  }

  edit(id: Mt5ProfileId): void {
    this.editing = id;
    this.health = null;
    this.message = '';
  }

  /** Toggle: perfil que se usa al enviar operaciones a MT5 (se guarda al instante). */
  setActive(id: Mt5ProfileId): void {
    if (!this.state || this.state.active === id || this.switching) return;
    this.switching = true;
    this.api.mt5SettingsSave({ active: id }).subscribe({
      next: (s) => {
        this.switching = false;
        if (this.state) this.state = { ...this.state, active: s.active };
        this.showMessage(`Las operaciones MT5 usarán ahora ${this.label(s.active)}.`, false);
      },
      error: (err: unknown) => {
        this.switching = false;
        this.showMessage(this.errMsg(err, 'No se pudo cambiar el perfil activo.'), true);
      },
    });
  }

  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.reversalConfirm) this.cancelReversals();
  }

  /** Activar pide confirmación; desactivar es inmediato. */
  toggleReversals(): void {
    const d = this.draft;
    if (!d) return;
    if (d.form.reversalsEnabled) {
      d.form.reversalsEnabled = false;
      return;
    }
    this.reversalTrigger = document.activeElement as HTMLElement | null;
    this.reversalConfirm = this.editing;
  }

  confirmReversals(): void {
    const d = this.reversalConfirm ? this.drafts[this.reversalConfirm] : null;
    if (d) d.form.reversalsEnabled = true;
    this.closeReversalConfirm();
  }

  cancelReversals(): void {
    this.closeReversalConfirm();
  }

  noLimitsWarning(f: Mt5Settings): string {
    const missing = [!f.maxTradesPerDay && 'operaciones', !f.maxDailyDrawdownPct && 'drawdown'].filter(Boolean);
    return `⚠ Sin límite diario de ${missing.join(' ni de ')} configurado.`;
  }

  private closeReversalConfirm(): void {
    this.reversalConfirm = null;
    this.reversalTrigger?.focus();
    this.reversalTrigger = null;
  }

  copyFromOther(): void {
    const other = this.state?.profiles[this.otherProfile];
    const current = this.draft;
    if (!other || !current) return;
    const copy = this.toDraft({ ...other, hasToken: current.form.hasToken });
    this.drafts[this.editing] = { ...copy, tokenInput: current.tokenInput, clearToken: current.clearToken };
    this.showMessage(`Valores copiados de ${this.label(this.otherProfile)} (sin token). Pulsa Guardar.`, false);
  }

  restoreDefaults(): void {
    const current = this.draft;
    if (!this.state || !current) return;
    this.drafts[this.editing] = this.toDraft({ ...this.state.defaults, hasToken: current.form.hasToken });
    this.showMessage('Valores por defecto cargados. Pulsa Guardar para aplicarlos.', false);
  }

  discard(): void {
    if (!this.state) return;
    this.drafts[this.editing] = this.toDraft(this.state.profiles[this.editing]);
    this.message = '';
  }

  save(): void {
    const d = this.draft;
    if (!d || this.saving) return;
    const f = d.form;
    const settings: Mt5SettingsPatch = {
      bridgeUrl: f.bridgeUrl.trim(),
      symbols: { ...f.symbols },
      riskPct: f.riskPct,
      volume: d.lotMode === 'fixed' ? d.fixedVolume : null,
      maxDeviationPct: f.maxDeviationPct,
      expiryMinutes: f.expiryMinutes,
      deviationPoints: f.deviationPoints,
      allowMultiple: f.allowMultiple,
      reversalsEnabled: f.reversalsEnabled,
      maxTradesPerDay: f.maxTradesPerDay,
      maxDailyDrawdownPct: f.maxDailyDrawdownPct,
      extraSlPips: f.extraSlPips,
      extraTpPips: f.extraTpPips,
      pipSize: { ...f.pipSize },
    };
    if (d.clearToken) settings.bridgeToken = '';
    else if (d.tokenInput.trim()) settings.bridgeToken = d.tokenInput.trim();

    const profile = this.editing;
    this.saving = true;
    this.api.mt5SettingsSave({ profile, settings }).subscribe({
      next: (s) => {
        this.saving = false;
        this.state = s;
        this.drafts[profile] = this.toDraft(s.profiles[profile]);
        const inUse = s.active === profile ? ' Es el perfil activo: se usará en el próximo envío.' : '';
        this.showMessage(`${this.label(profile)} guardada.${inUse}`, false);
      },
      error: (err: unknown) => {
        this.saving = false;
        this.showMessage(this.errMsg(err, 'No se pudo guardar la configuración.'), true);
      },
    });
  }

  testConnection(): void {
    const profile = this.editing;
    this.testing = true;
    this.health = null;
    this.api.mt5Health(profile).subscribe({
      next: (h) => {
        this.testing = false;
        this.health = h;
      },
      error: (err: unknown) => {
        this.testing = false;
        const body = (err as { error?: Mt5Health } | null)?.error;
        this.health = {
          ok: false,
          profile,
          bridgeUrl: body?.bridgeUrl ?? this.draft?.form.bridgeUrl ?? '',
          error: body?.error || 'No se pudo contactar el puente MT5.',
        };
      },
    });
  }

  private toDraft(s: Mt5Settings): ProfileDraft {
    return {
      form: { ...s, symbols: { ...s.symbols }, pipSize: { ...s.pipSize } },
      lotMode: s.volume ? 'fixed' : 'risk',
      fixedVolume: s.volume ?? 0.01,
      tokenInput: '',
      clearToken: false,
    };
  }

  private showMessage(text: string, isErr: boolean): void {
    this.message = text;
    this.messageErr = isErr;
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => (this.message = ''), isErr ? 9000 : 5000);
  }

  private errMsg(err: unknown, fallback: string): string {
    const e = err as { error?: { error?: string } } | null;
    return e?.error?.error || fallback;
  }
}
