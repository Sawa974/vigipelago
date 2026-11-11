import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';

import { I18n } from './i18n/i18n.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Avant le premier rendu : pas d'anglais en eclair.
    provideAppInitializer(() => inject(I18n).init()),
  ]
};
