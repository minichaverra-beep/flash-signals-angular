import { Component, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService, loginErrorMessage } from '../../services/auth.service';

/** Acceso discreto «Admin»: abre un modal de login o muestra la sesión activa. */
@Component({
  selector: 'app-admin-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './admin-login.component.html',
  styleUrl: './admin-login.component.scss',
})
export class AdminLoginComponent {
  readonly auth = inject(AuthService);

  readonly open = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  username = 'admin';
  password = '';

  private readonly userInput = viewChild<ElementRef<HTMLInputElement>>('userInput');

  openDialog(): void {
    this.error.set('');
    this.password = '';
    this.open.set(true);
    setTimeout(() => this.userInput()?.nativeElement.focus());
  }

  close(): void {
    if (this.busy()) return;
    this.open.set(false);
    this.password = '';
    this.error.set('');
  }

  submit(): void {
    if (this.busy()) return;
    const user = this.username.trim();
    if (!user || !this.password) {
      this.error.set('Escribe usuario y contraseña.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.auth.login(user, this.password).subscribe({
      next: () => {
        this.busy.set(false);
        this.close();
      },
      error: (err) => {
        this.busy.set(false);
        this.password = '';
        this.error.set(loginErrorMessage(err));
      },
    });
  }

  logout(): void {
    this.auth.logout();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.close();
  }
}
