import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { HistorialComponent } from './pages/historial/historial.component';
import { WikiComponent } from './pages/wiki/wiki.component';
import { PlataformaComponent } from './pages/plataforma/plataforma.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'plataforma', component: PlataformaComponent },
  { path: 'colombia', redirectTo: 'plataforma' },
  { path: 'mercado', redirectTo: 'plataforma' },
  { path: 'historial', component: HistorialComponent },
  { path: 'wiki', component: WikiComponent },
  { path: 'artefactos', redirectTo: 'wiki' },
  { path: '**', redirectTo: '' },
];
