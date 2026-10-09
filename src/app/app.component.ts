import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ImageViewerComponent } from './shared/image-viewer/image-viewer.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ImageViewerComponent],
  template: `<router-outlet /><app-image-viewer />`,
  styles: [`:host { display: block; min-height: 100vh; }`],
})
export class AppComponent {}
