import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { SignalJobService } from './services/signal-job.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(),
    // Conecta el SSE del job al arrancar (F5 en cualquier ruta recupera la corrida).
    provideAppInitializer(() => {
      inject(SignalJobService);
    }),
  ],
};
