import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';

function isApiUrl(url: string): boolean {
  if (url.startsWith('/api/') || url === '/api') return true;
  try {
    const parsed = new URL(url, location.origin);
    return parsed.origin === location.origin && parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Añade el Bearer admin a /api y cierra la sesión local si el server lo rechaza. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const device = inject(DeviceService);
  const api = isApiUrl(req.url);
  let headers = req.headers;
  if (api && device.mt5Hidden()) headers = headers.set('X-FS-Client', 'small');
  const token = auth.token();
  const withAuth = Boolean(api && token && !req.url.includes('/api/auth/login') && !req.headers.has('Authorization'));
  if (withAuth) headers = headers.set('Authorization', `Bearer ${token}`);
  const outgoing = headers === req.headers ? req : req.clone({ headers });
  if (!withAuth) return next(outgoing);
  return next(outgoing).pipe(
    catchError((err: unknown) => {
      // Solo 401 de sesión admin (otros 401, p.ej. contraseña de historial, no cierran sesión).
      const sessionRejected =
        err instanceof HttpErrorResponse &&
        err.status === 401 &&
        (err.error?.code === 'admin_required' || req.url.includes('/api/auth/me'));
      if (sessionRejected && auth.token() === token) auth.clearLocal();
      return throwError(() => err);
    })
  );
};
