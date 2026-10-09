import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Subject, Subscription, forkJoin, of } from 'rxjs';
import { catchError, debounceTime, switchMap } from 'rxjs/operators';
import {
  AccountSettings,
  Mt5DailyLimit,
  Mt5Health,
  Mt5ProfileId,
  Mt5Settings,
  Mt5SettingsPatch,
  Mt5SettingsState,
  Mt5SignalMarket,
  SignalsApiService,
  VixReading,
  VolatilityCalcResult,
  VolatilityLevel,
  VolatilityMood,
} from '../../services/signals-api.service';
import {
  LEVEL_BY_MOOD,
  LEVEL_IDS,
  LEVEL_LABELS,
  MOOD_BY_LEVEL,
  MOOD_IDS,
  MOOD_LABELS,
  ageText,
  classifyVix,
  formatMoney,
  formatNumber,
  levelMultiplier,
  levelRangeText,
  riskRewardBar,
  thermometer,
} from './volatility.helpers';
import { AdminLoginComponent } from '../../shared/admin-login/admin-login.component';
import { DeviceService } from '../../services/device.service';

type LotMode = 'risk' | 'fixed';
type MultKey = 'vixMultLow' | 'vixMultNormal' | 'vixMultHigh' | 'vixMultExtreme';
type LimitKey = 'vixLowMax' | 'vixNormalMax' | 'vixHighMax';

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
  imports: [CommonModule, FormsModule, RouterLink, RouterLinkActive, AdminLoginComponent],
  templateUrl: './configuracion.component.html',
  styleUrl: './configuracion.component.scss',
})
export class ConfiguracionComponent implements OnInit, OnDestroy {
  private readonly api = inject(SignalsApiService);
  /** APK o pantalla pequeña: sin secciones MT5, solo balance y % de riesgo para el lote recomendado. */
  readonly mt5Hidden = inject(DeviceService).mt5Hidden;

  /** Balance y % de riesgo guardados en la BD (/api/account-settings). */
  account: AccountSettings | null = null;
  /** Input del balance (móvil y escritorio); tras guardar se rellena con la respuesta del servidor. */
  accountBalance: number | null = null;
  balanceSaving = false;
  /** Gestión de riesgo (móvil): % de riesgo (BD + perfil activo) y límite diario (perfil activo). */
  mobileRiskPct: number | null = null;
  mobileTradeLimitEnabled = true;
  mobileMaxTrades: number | null = null;
  mobileSaving = false;

  /** Operaciones de hoy del perfil activo frente a su límite diario. */
  dailyLimit: Mt5DailyLimit | null = null;

  readonly profileIds = PROFILE_IDS;
  /** Perfiles visibles en la pantalla (la «secundaria» está oculta; sigue existiendo en el backend). */
  readonly visibleProfileIds: Mt5ProfileId[] = ['principal'];
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
  volSaving = false;
  message = '';
  messageErr = false;
  private messageTimer: ReturnType<typeof setTimeout> | null = null;

  health: Mt5Health | null = null;
  testing = false;

  /** Perfil cuyo borrador espera confirmación para activar reversiones. */
  reversalConfirm: Mt5ProfileId | null = null;
  private reversalTrigger: HTMLElement | null = null;

  // --- Volatilidad (VIX) ---
  readonly levelIds = LEVEL_IDS;
  readonly levelLabels = LEVEL_LABELS;
  vix: VixReading | null = null;
  vixLoading = false;
  vixError = '';
  private vixAt = 0;

  // --- Calculadora de volatilidad ---
  readonly moodIds = MOOD_IDS;
  readonly moodLabels = MOOD_LABELS;
  readonly moodHints: Record<VolatilityMood, string> = {
    tranquilo: 'Casi sin movimiento',
    normal: 'Un día corriente',
    movido: 'Sube y baja con fuerza',
    muy_movido: 'Saltos bruscos, noticias',
  };
  calcMarket: Mt5SignalMarket = 'btc';
  calcRisk = 0.5;
  calcMood: VolatilityMood = 'normal';
  /** El estado de ánimo del mercado se preseleccionó con el VIX (se oculta al elegir a mano). */
  calcMoodFromVix = false;
  calcBalance: number | null = null;
  /** Saldo rellenado desde «Probar conexión» (se descarta al cambiar de perfil). */
  private calcBalanceAuto = false;
  calcResult: VolatilityCalcResult | null = null;
  calcLoading = false;
  calcError = '';
  private readonly calcRequests = new Subject<void>();
  private calcSub: Subscription | null = null;
  private calcSeeded = false;

  /** La calculadora usa el puente MT5: solo se lanza al volver a escritorio. */
  private readonly mt5VisibleEffect = effect(() => {
    if (!this.mt5Hidden() && this.state) untracked(() => this.scheduleCalc());
  });

  ngOnInit(): void {
    this.calcSub = this.calcRequests
      .pipe(
        debounceTime(250),
        switchMap(() => {
          const d = this.draft;
          if (!d) return of(null);
          this.calcLoading = true;
          return this.api
            .volatilityCalc({
              market: this.calcMarket,
              mood: this.calcMood,
              riskPct: this.calcRisk,
              balance: this.calcBalance && this.calcBalance > 0 ? this.calcBalance : null,
              multiplier: levelMultiplier(LEVEL_BY_MOOD[this.calcMood], d.form),
              pipSize: d.form.pipSize[this.calcMarket],
              profile: this.editing,
            })
            .pipe(
              catchError((err: unknown) => {
                this.calcError = this.errMsg(err, 'No se pudo calcular (¿API o puente MT5 sin conexión?).');
                return of(null);
              })
            );
        })
      )
      .subscribe((result) => {
        this.calcLoading = false;
        if (result) {
          this.calcResult = result;
          this.calcError = '';
        } else if (this.calcError) {
          this.calcResult = null;
        }
      });
    this.load();
  }

  ngOnDestroy(): void {
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.calcSub?.unsubscribe();
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
        this.editing = this.visibleProfileIds.includes(s.active) ? s.active : this.visibleProfileIds[0];
        this.syncMobileRisk(s);
        this.loadDailyLimit();
        this.health = null;
        if (!this.calcSeeded) {
          this.calcSeeded = true;
          this.calcRisk = Math.min(3, Math.max(0.1, this.draft?.form.riskPct ?? 0.5));
        }
        this.scheduleCalc();
      },
      error: (err: unknown) => {
        this.loading = false;
        this.showMessage(this.errMsg(err, 'No se pudo leer la configuración (¿API arrancada?).'), true);
      },
    });
    this.loadAccount();
  }

  private loadAccount(): void {
    this.api.accountSettings().subscribe({
      next: (a) => this.applyAccount(a),
      error: (err: unknown) =>
        this.showMessage(this.errMsg(err, 'No se pudo leer el balance guardado (¿API reiniciada?).'), true),
    });
  }

  private applyAccount(a: AccountSettings): void {
    this.account = a;
    this.accountBalance = a.balance;
    if (a.riskPct != null) this.mobileRiskPct = a.riskPct;
  }

  get balanceValid(): boolean {
    const b = this.accountBalance;
    return b != null && Number.isFinite(Number(b)) && b > 0;
  }

  /** El % de riesgo del perfil activo también alimenta el lote recomendado (BD); no toca el input del balance. */
  private syncAccountRisk(riskPct: number): void {
    if (this.account?.riskPct === riskPct) return;
    this.api.accountSettingsSave({ riskPct }).subscribe({
      next: (a) => (this.account = a),
      error: (err: unknown) =>
        this.showMessage(this.errMsg(err, 'Configuración guardada, pero no se pudo actualizar el % de riesgo del lote recomendado.'), true),
    });
  }

  /** Escritorio: guarda solo el balance (el % de riesgo va en «Tamaño de la posición»). */
  saveBalance(): void {
    if (this.balanceSaving || !this.balanceValid) return;
    this.balanceSaving = true;
    this.api.accountSettingsSave({ balance: Number(this.accountBalance) }).subscribe({
      next: (a) => {
        this.balanceSaving = false;
        this.account = a;
        this.accountBalance = a.balance;
        this.showMessage('Balance guardado.', false);
      },
      error: (err: unknown) => {
        this.balanceSaving = false;
        this.showMessage(this.errMsg(err, 'No se pudo guardar el balance.'), true);
      },
    });
  }

  edit(id: Mt5ProfileId): void {
    this.editing = id;
    this.health = null;
    this.message = '';
    if (this.calcBalanceAuto) this.calcBalance = null;
    this.scheduleCalc();
  }

  /** Toggle: perfil que se usa al enviar operaciones a MT5 (se guarda al instante). */
  setActive(id: Mt5ProfileId): void {
    if (!this.state || this.state.active === id || this.switching) return;
    this.switching = true;
    this.api.mt5SettingsSave({ active: id }).subscribe({
      next: (s) => {
        this.switching = false;
        if (this.state) this.state = { ...this.state, active: s.active };
        this.loadDailyLimit();
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
    const missing = [!f.dailyTradeLimitEnabled && 'operaciones', !f.maxDailyDrawdownPct && 'drawdown'].filter(Boolean);
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
    this.scheduleCalc();
    this.showMessage(`Valores copiados de ${this.label(this.otherProfile)} (sin token). Pulsa Guardar.`, false);
  }

  restoreDefaults(): void {
    const current = this.draft;
    if (!this.state || !current) return;
    this.drafts[this.editing] = this.toDraft({ ...this.state.defaults, hasToken: current.form.hasToken });
    this.scheduleCalc();
    this.showMessage('Valores por defecto cargados. Pulsa Guardar para aplicarlos.', false);
  }

  discard(): void {
    if (!this.state) return;
    this.drafts[this.editing] = this.toDraft(this.state.profiles[this.editing]);
    this.message = '';
    this.scheduleCalc();
  }

  private syncMobileRisk(s: Mt5SettingsState): void {
    const p = s.profiles[s.active];
    this.mobileRiskPct = this.account?.riskPct ?? p.riskPct;
    this.mobileTradeLimitEnabled = p.dailyTradeLimitEnabled;
    this.mobileMaxTrades = p.maxTradesPerDay;
  }

  private loadDailyLimit(): void {
    this.api.mt5DailyLimit().subscribe({
      next: (r) => (this.dailyLimit = r),
      error: () => (this.dailyLimit = null),
    });
  }

  tradeCountText(dl: Mt5DailyLimit): string {
    if (!dl.enabled) return `Operaciones hoy: ${dl.count} (sin límite)`;
    return `Operaciones hoy: ${dl.count} / ${dl.limit}${dl.reached ? ' · límite alcanzado' : ''}`;
  }

  get mobileRiskValid(): boolean {
    const r = this.mobileRiskPct;
    const m = this.mobileMaxTrades;
    const maxOk = !this.mobileTradeLimitEnabled || (m != null && Number.isInteger(m) && m >= 1 && m <= 100);
    return this.balanceValid && r != null && r > 0 && r <= 5 && maxOk;
  }

  /**
   * «Gestión de riesgo (móvil)»: balance y % de riesgo en la BD; % de riesgo y límite diario
   * también en el perfil activo (envío a MT5 desde el PC).
   */
  saveMobileRisk(): void {
    const st = this.state;
    if (!st || this.mobileSaving || !this.mobileRiskValid) return;
    const profile = st.active;
    const riskPct = Number(this.mobileRiskPct);
    this.mobileSaving = true;
    const settings: Mt5SettingsPatch = {
      riskPct,
      dailyTradeLimitEnabled: this.mobileTradeLimitEnabled,
    };
    if (this.mobileTradeLimitEnabled) settings.maxTradesPerDay = this.mobileMaxTrades!;
    forkJoin({
      account: this.api.accountSettingsSave({ balance: Number(this.accountBalance), riskPct }),
      mt5: this.api.mt5SettingsSave({ profile, settings }),
    })
      .subscribe({
        next: ({ account, mt5: s }) => {
          this.mobileSaving = false;
          this.state = s;
          this.drafts[profile] = this.toDraft(s.profiles[profile]);
          this.applyAccount(account);
          this.syncMobileRisk(s);
          this.loadDailyLimit();
          this.showMessage('Balance guardado. Riesgo y límite diario actualizados.', false);
        },
        error: (err: unknown) => {
          this.mobileSaving = false;
          this.showMessage(this.errMsg(err, 'No se pudo guardar el balance.'), true);
        },
      });
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
      dailyTradeLimitEnabled: f.dailyTradeLimitEnabled,
      ...(f.dailyTradeLimitEnabled ? { maxTradesPerDay: f.maxTradesPerDay } : {}),
      maxDailyDrawdownPct: f.maxDailyDrawdownPct,
      extraSlPips: f.extraSlPips,
      extraTpPips: f.extraTpPips,
      pipSize: { ...f.pipSize },
      volatilityAdjustEnabled: f.volatilityAdjustEnabled,
      vixSymbol: (f.vixSymbol ?? '').trim(),
      vixLowMax: f.vixLowMax,
      vixNormalMax: f.vixNormalMax,
      vixHighMax: f.vixHighMax,
      vixMultLow: f.vixMultLow,
      vixMultNormal: f.vixMultNormal,
      vixMultHigh: f.vixMultHigh,
      vixMultExtreme: f.vixMultExtreme,
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
        if (s.active === profile) {
          this.loadDailyLimit();
          this.syncAccountRisk(s.profiles[profile].riskPct);
        }
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
        if (h.ok && h.account && !this.calcBalance) {
          this.calcBalance = Math.round(h.account.equity * 100) / 100;
          this.calcBalanceAuto = true;
          this.scheduleCalc();
        }
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

  // --- Volatilidad (VIX) ---

  /** Interruptor del ajuste por VIX: se guarda al instante (solo este campo); los multiplicadores se conservan. */
  toggleVolatility(): void {
    const d = this.draft;
    if (!d || this.volSaving) return;
    const profile = this.editing;
    const enabled = !d.form.volatilityAdjustEnabled;
    d.form.volatilityAdjustEnabled = enabled;
    this.volSaving = true;
    this.api.mt5SettingsSave({ profile, settings: { volatilityAdjustEnabled: enabled } }).subscribe({
      next: (s) => {
        this.volSaving = false;
        const saved = s.profiles[profile].volatilityAdjustEnabled;
        if (this.state) {
          const current = { ...this.state.profiles[profile], volatilityAdjustEnabled: saved };
          this.state = { ...this.state, profiles: { ...this.state.profiles, [profile]: current } };
        }
        const draft = this.drafts[profile];
        if (draft) draft.form.volatilityAdjustEnabled = saved;
        this.showMessage(`Ajuste por VIX ${saved ? 'activado' : 'desactivado'} en ${this.label(profile)}.`, false);
      },
      error: (err: unknown) => {
        this.volSaving = false;
        const draft = this.drafts[profile];
        if (draft) draft.form.volatilityAdjustEnabled = !enabled;
        this.showMessage(this.errMsg(err, 'No se pudo guardar el ajuste por VIX.'), true);
      },
    });
  }

  /** Botón «Calcular VIX actual»: lee el VIX (broker o Yahoo) y preselecciona el ánimo de la calculadora. */
  calcVix(): void {
    if (this.vixLoading) return;
    this.vixLoading = true;
    this.vixError = '';
    this.api.vixCurrent(this.editing).subscribe({
      next: (r) => {
        this.vixLoading = false;
        this.vix = r;
        this.vixAt = Date.now();
        const level = this.vixLevel;
        if (level) {
          this.calcMood = MOOD_BY_LEVEL[level];
          this.calcMoodFromVix = true;
          this.scheduleCalc();
        }
      },
      error: (err: unknown) => {
        this.vixLoading = false;
        this.vix = null;
        this.vixError = this.errMsg(err, 'No se pudo obtener el VIX (¿API arrancada?).');
      },
    });
  }

  /** Nivel actual con los umbrales del borrador (puede diferir de los guardados). */
  get vixLevel(): VolatilityLevel | null {
    const d = this.draft;
    return d && this.vix ? classifyVix(this.vix.points, d.form) : null;
  }

  get vixMultiplier(): number {
    const d = this.draft;
    return d ? levelMultiplier(this.vixLevel, d.form) : 1;
  }

  get vixThermo() {
    const d = this.draft;
    return d ? thermometer(this.vix?.points ?? null, d.form) : null;
  }

  get vixAge(): string {
    return this.vix ? ageText(this.vix.asOf, this.vixAt || Date.now()) : '';
  }

  levelRange(level: VolatilityLevel): string {
    const d = this.draft;
    return d ? levelRangeText(level, d.form) : '';
  }

  /** Filas de la tabla de niveles: multiplicador y umbral superior editables del borrador. */
  readonly levelRows: { level: VolatilityLevel; mult: MultKey; limit: LimitKey | null }[] = [
    { level: 'baja', mult: 'vixMultLow', limit: 'vixLowMax' },
    { level: 'normal', mult: 'vixMultNormal', limit: 'vixNormalMax' },
    { level: 'alta', mult: 'vixMultHigh', limit: 'vixHighMax' },
    { level: 'extrema', mult: 'vixMultExtreme', limit: null },
  ];

  /** «Ensancha 30 %», «Estrecha 20 %» o «Sin cambios» según el multiplicador del borrador. */
  effectText(mult: MultKey): string {
    const m = Number(this.draft?.form[mult]);
    if (!Number.isFinite(m) || m === 1) return 'Sin cambios';
    const pct = Math.round(Math.abs(m - 1) * 100);
    return m > 1 ? `Ensancha ${pct} %` : `Estrecha ${pct} %`;
  }

  /** Aviso si los umbrales no están en orden creciente (el servidor los rechazaría al guardar). */
  get thresholdsInvalid(): boolean {
    const f = this.draft?.form;
    return !!f && !(f.vixLowMax > 0 && f.vixLowMax < f.vixNormalMax && f.vixNormalMax < f.vixHighMax);
  }

  // --- Calculadora de volatilidad ---

  scheduleCalc(): void {
    if (this.mt5Hidden()) return;
    this.calcRequests.next();
  }

  setCalcMarket(market: Mt5SignalMarket): void {
    this.calcMarket = market;
    this.scheduleCalc();
  }

  setCalcMood(mood: VolatilityMood): void {
    this.calcMood = mood;
    this.calcMoodFromVix = false;
    this.scheduleCalc();
  }

  onCalcRiskChange(): void {
    this.calcRisk = Math.min(5, Math.max(0.1, Number(this.calcRisk) || 0.1));
    this.scheduleCalc();
  }

  onCalcBalanceChange(): void {
    this.calcBalanceAuto = false;
    this.scheduleCalc();
  }

  get calcMultiplier(): number {
    const d = this.draft;
    return d ? levelMultiplier(LEVEL_BY_MOOD[this.calcMood], d.form) : 1;
  }

  get calcBar() {
    const p = this.calcResult?.plan;
    return riskRewardBar(p?.riskAmount ?? 0, p?.rewardAmount ?? 0);
  }

  money(n: number, currency?: string): string {
    return formatMoney(n, currency);
  }

  num(n: number, maxDecimals = 2): string {
    return formatNumber(n, maxDecimals);
  }

  /** «Usar estos valores»: copia al borrador el margen extra (pips) y el riesgo %; no guarda. */
  useCalcValues(): void {
    const r = this.calcResult;
    const d = this.draft;
    if (!r || !d) return;
    d.form.extraSlPips = r.plan.extraSlPips;
    d.form.extraTpPips = r.plan.extraTpPips;
    d.form.riskPct = r.riskPct;
    const fixed = d.lotMode === 'fixed' ? ' Estás en «Lotes fijos»: el riesgo % se usará cuando elijas «Riesgo % de la cuenta».' : '';
    this.showMessage(
      `Copiado al borrador: margen extra SL ${r.plan.extraSlPips} pips · TP ${r.plan.extraTpPips} pips · riesgo ${r.riskPct} %. Pulsa Guardar para aplicarlo.${fixed}`,
      false
    );
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
