import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-plataforma',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './plataforma.component.html',
  styleUrl: './plataforma.component.scss',
})
export class PlataformaComponent {
  readonly tiers = [
    {
      id: 'Context',
      title: 'Context',
      hint: 'Estructura M5 sin forzar Entry. Lee el mapa antes de operar.',
    },
    {
      id: 'Light',
      title: 'Light',
      hint: 'Chequeo rápido: bias, setup y scores sin el peso del High.',
    },
    {
      id: 'High',
      title: 'High',
      hint: 'Señal de entrada del día a día — plan, riesgo y gráfico.',
    },
    {
      id: 'History',
      title: 'History',
      hint: 'P&L de la última Entry. Auditoría, no señal nueva.',
    },
  ] as const;

  readonly steps = [
    'Elige mercado (BTC, US30 o XAUUSD) y el tier.',
    'Define bias y setup; activa ML / Neural si quieres capas extra.',
    'Ejecuta la señal: el pipeline real corre en tu máquina (PowerShell → Python).',
    'Lee el reporte en Vista rápida, Detallada o Modo Inversor.',
    'Revisa el historial local (debajo, en Señales) o la Wiki de artefactos cuando necesites contexto.',
  ] as const;

  readonly trust = [
    {
      label: 'Reglas',
      text: 'Checklist y estructura 2M5 / E1 — sin inventar veredictos.',
    },
    {
      label: 'ML',
      text: 'Modelo automático como capa de probabilidad, no como oráculo.',
    },
    {
      label: 'Neural',
      text: 'Capa neural opcional para confluencia con reglas y ML.',
    },
  ] as const;
}
