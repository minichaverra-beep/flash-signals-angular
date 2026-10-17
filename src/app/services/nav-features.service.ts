import { Injectable, inject, signal } from '@angular/core';
import { ReplaySubject } from 'rxjs';
import { SignalsApiService } from './signals-api.service';

/**
 * Visibilidad global de Wiki y Quantum.
 * Arranca en false hasta leer account-settings. Un cambio a true muestra
 * el botón del menú y abre la ruta al instante.
 */
@Injectable({ providedIn: 'root' })
export class NavFeaturesService {
  private readonly api = inject(SignalsApiService);
  private readonly readySubject = new ReplaySubject<void>(1);
  /** Escrituras en curso: un GET antiguo no debe apagar un interruptor recién activado. */
  private writes = 0;
  /** Sube en cada cambio local para descartar un GET que salió antes. */
  private editStamp = 0;

  readonly wikiEnabled = signal(false);
  readonly quantumEnabled = signal(false);
  readonly ready$ = this.readySubject.asObservable();

  constructor() {
    this.refresh();
  }

  refresh(): void {
    const stamp = this.editStamp;
    this.api.accountSettings().subscribe({
      next: (a) => {
        if (stamp === this.editStamp) this.apply(a);
        this.readySubject.next();
      },
      error: () => {
        if (stamp === this.editStamp) this.apply(null);
        this.readySubject.next();
      },
    });
  }

  beginWrite(): void {
    this.writes += 1;
  }

  endWrite(): void {
    this.writes = Math.max(0, this.writes - 1);
  }

  apply(settings: { wikiEnabled?: boolean; quantumEnabled?: boolean } | null | undefined): void {
    if (this.writes > 0) return;
    this.wikiEnabled.set(settings?.wikiEnabled === true);
    this.quantumEnabled.set(settings?.quantumEnabled === true);
  }

  /** El interruptor ya decidió: el menú cambia sin esperar al GET. */
  show(settings: { wikiEnabled: boolean; quantumEnabled: boolean }): void {
    this.editStamp += 1;
    this.wikiEnabled.set(settings.wikiEnabled);
    this.quantumEnabled.set(settings.quantumEnabled);
  }
}
