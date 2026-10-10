import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ImageViewerComponent } from './shared/image-viewer/image-viewer.component';
import { DownloadService } from './services/download.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ImageViewerComponent],
  template: `<router-outlet /><app-image-viewer />
    @if (downloads.notice(); as n) {
      <div class="download-notice" [class.is-error]="!n.ok" [attr.role]="n.ok ? 'status' : 'alert'" (click)="downloads.dismiss()">
        {{ n.message }}
      </div>
    }`,
  styles: [
    `:host { display: block; min-height: 100vh; }
     .download-notice {
       position: fixed;
       left: 50%;
       bottom: calc(env(safe-area-inset-bottom, 0px) + 1.25rem);
       transform: translateX(-50%);
       z-index: 10001;
       max-width: min(92vw, 28rem);
       padding: 0.7rem 1rem;
       border-radius: 10px;
       background: #1e9e63;
       color: #fff;
       font: 600 0.92rem/1.3 var(--font, sans-serif);
       text-align: center;
       box-shadow: 0 6px 20px rgb(0 0 0 / 0.45);
       cursor: pointer;
     }
     .download-notice.is-error { background: #cd1818; }`,
  ],
})
export class AppComponent {
  readonly downloads = inject(DownloadService);
}
