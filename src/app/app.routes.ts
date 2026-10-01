import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { HistorialComponent } from './pages/historial/historial.component';
import { WikiComponent } from './pages/wiki/wiki.component';
import { PlataformaComponent } from './pages/plataforma/plataforma.component';
import { MacdQuantComponent } from './pages/macd-quant/macd-quant.component';
import { ConfiguracionComponent } from './pages/configuracion/configuracion.component';

export const routes: Routes = [
  { path: '', component: PlataformaComponent },
  { path: 'senales', component: HomeComponent },
  { path: 'plataforma', redirectTo: '' },
  { path: 'macd-quant', component: MacdQuantComponent },
  { path: 'quantum', redirectTo: 'macd-quant' },
  { path: 'colombia', redirectTo: '' },
  { path: 'mercado', redirectTo: '' },
  { path: 'historial', component: HistorialComponent },
  { path: 'wiki', component: WikiComponent },
  { path: 'artefactos', redirectTo: 'wiki' },
  { path: 'configuracion', component: ConfiguracionComponent },
  { path: '**', redirectTo: '' },
];
