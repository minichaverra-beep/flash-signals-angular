import { Routes } from '@angular/router';
import { HistorialComponent } from './pages/historial/historial.component';
import { WikiComponent } from './pages/wiki/wiki.component';
import { PlataformaComponent } from './pages/plataforma/plataforma.component';
import { MacdQuantComponent } from './pages/macd-quant/macd-quant.component';
import { ConfiguracionComponent } from './pages/configuracion/configuracion.component';

export const routes: Routes = [
  { path: '', component: PlataformaComponent },
  /** Señales: formulario de corrida + historial local en una sola página. */
  { path: 'senales', component: HistorialComponent },
  { path: 'historial', redirectTo: 'senales' },
  { path: 'plataforma', redirectTo: '' },
  { path: 'macd-quant', component: MacdQuantComponent },
  { path: 'quantum', redirectTo: 'macd-quant' },
  { path: 'colombia', redirectTo: '' },
  { path: 'mercado', redirectTo: '' },
  { path: 'wiki', component: WikiComponent },
  { path: 'artefactos', redirectTo: 'wiki' },
  { path: 'configuracion', component: ConfiguracionComponent },
  { path: '**', redirectTo: '' },
];
