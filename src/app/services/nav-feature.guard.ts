import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map, take } from 'rxjs/operators';
import { NavFeaturesService } from './nav-features.service';

/** /wiki solo si Activar wiki está guardado en la BD. */
export const wikiEnabledGuard: CanActivateFn = () => {
  const nav = inject(NavFeaturesService);
  const router = inject(Router);
  return nav.ready$.pipe(
    take(1),
    map(() => (nav.wikiEnabled() ? true : router.createUrlTree(['/senales']))),
  );
};

/** /macd-quant solo si Activar quantum está guardado en la BD. */
export const quantumEnabledGuard: CanActivateFn = () => {
  const nav = inject(NavFeaturesService);
  const router = inject(Router);
  return nav.ready$.pipe(
    take(1),
    map(() => (nav.quantumEnabled() ? true : router.createUrlTree(['/senales']))),
  );
};
