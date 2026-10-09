import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';

export interface AdminUser {
  username: string;
  role: 'admin';
}

interface LoginResponse {
  ok: boolean;
  token: string;
  user: AdminUser;
  expiresAt: string;
}

interface MeResponse {
  authenticated: boolean;
  user?: AdminUser;
  expiresAt?: string;
}

const TOKEN_KEY = 'flash-signals.admin-token';
const USER_KEY = 'flash-signals.admin-user';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* modo privado / WebView sin storage: la sesión vive solo en memoria */
  }
}

/**
 * Sesión admin opcional: la app es pública; el admin solo desbloquea gestión
 * de la Wiki y los botones de borrar.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly tokenSig = signal<string | null>(readStorage(TOKEN_KEY));
  private readonly userSig = signal<string | null>(readStorage(USER_KEY));

  readonly token = this.tokenSig.asReadonly();
  readonly username = this.userSig.asReadonly();
  readonly isAdmin = computed(() => !!this.tokenSig());

  /** Revalida el token guardado; 401 → el interceptor cierra la sesión local. */
  init(): void {
    if (!this.tokenSig()) return;
    this.http.get<MeResponse>('/api/auth/me').subscribe({
      next: (me) => {
        if (me.authenticated && me.user) this.setSession(this.tokenSig(), me.user.username);
        else this.clearLocal();
      },
      error: () => {
        /* Sin red / API caída: se conserva la sesión hasta la próxima respuesta 401. */
      },
    });
  }

  login(username: string, password: string): Observable<AdminUser> {
    return this.http
      .post<LoginResponse>('/api/auth/login', { username, password })
      .pipe(
        tap((res) => this.setSession(res.token, res.user.username)),
        map((res) => res.user)
      );
  }

  logout(): void {
    const token = this.tokenSig();
    this.clearLocal();
    if (!token) return;
    this.http
      .post('/api/auth/logout', {}, { headers: { Authorization: `Bearer ${token}` } })
      .subscribe({ error: () => undefined });
  }

  clearLocal(): void {
    this.setSession(null, null);
  }

  private setSession(token: string | null, username: string | null): void {
    this.tokenSig.set(token);
    this.userSig.set(username);
    writeStorage(TOKEN_KEY, token);
    writeStorage(USER_KEY, username);
  }
}

/** Mensaje en español para errores de login. */
export function loginErrorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'No hay conexión con la API (:3847).';
    if (err.status === 401) return 'Usuario o contraseña incorrectos.';
    if (err.status === 429) return err.error?.error || 'Demasiados intentos. Espera unos minutos.';
    return err.error?.error || `Error del servidor (${err.status}).`;
  }
  return 'No se pudo iniciar sesión.';
}
