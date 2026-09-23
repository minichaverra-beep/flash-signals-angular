import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { HistorialComponent } from './pages/historial/historial.component';
import { WikiComponent } from './pages/wiki/wiki.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'historial', component: HistorialComponent },
  { path: 'wiki', component: WikiComponent },
  { path: 'artefactos', redirectTo: 'wiki' },
  { path: '**', redirectTo: '' },
];
