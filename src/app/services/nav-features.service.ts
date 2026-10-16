import { Injectable, inject, signal } from '@angular/core';
import { SignalsApiService } from './signals-api.service';

/**
 * Visibilidad global de los enlaces Wiki y Quantum.
 * Arranca en false para que el menú los oculte aunque la API todavía no conozca los campos.
 */
@Injectable({ providedIn: 'root' })
export class NavFeaturesService {
  private readonly api = inject(SignalsApiService);
  readonly wikiEnabled = signal(false);
  readonly quantumEnabled = signal(false);

  constructor() {
    this.refresh();
  }

  refresh(): void {
    this.api.accountSettings().subscribe({
      next: (a) => this.apply(a),
      error: () => this.apply(null),
    });
  }

  apply(settings: { wikiEnabled?: boolean; quantumEnabled?: boolean } | null | undefined): void {
    this.wikiEnabled.set(settings?.wikiEnabled === true);
    this.quantumEnabled.set(settings?.quantumEnabled === true);
  }
}
