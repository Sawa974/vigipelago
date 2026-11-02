import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { I18n } from '../i18n/i18n.service';

/** Le parent doit ecouter `closed` : le navigateur ferme le dialogue sans lui (echap, fond). */
@Component({
  selector: 'app-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dialog.html',
  styleUrl: './dialog.css',
})
export class Dialog {
  readonly heading = input.required<string>();
  readonly open = input(false);
  /** Vide : pas de bouton de validation. */
  readonly confirmLabel = input('');
  /** Vide : « Fermer » dans la langue de l'interface. */
  readonly closeLabel = input('');
  protected readonly t = inject(I18n).t;

  readonly closed = output<void>();
  readonly confirmed = output<void>();

  private readonly el = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const dlg = this.el().nativeElement;
      const want = this.open();
      // `showModal` sur un dialogue deja ouvert leve.
      if (want && !dlg.open) dlg.showModal();
      if (!want && dlg.open) dlg.close();
    });
  }

  /** Un clic sur le fond a pour cible le dialogue lui-meme ; un clic dedans, un enfant. */
  protected onBackdrop(e: MouseEvent): void {
    if (e.target === this.el().nativeElement) this.el().nativeElement.close();
  }
}
