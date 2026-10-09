import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { SignalJobService } from './services/signal-job.service';
import { AuthService } from './services/auth.service';
import { authInterceptor } from './services/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    // Conecta el SSE del job al arrancar (F5 en cualquier ruta recupera la corrida).
    provideAppInitializer(() => {
      inject(SignalJobService);
      inject(AuthService).init();
    }),
  ],
};
