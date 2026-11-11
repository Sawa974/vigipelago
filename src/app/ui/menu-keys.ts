import { afterNextRender, Directive, ElementRef, inject, input, OnDestroy, output } from '@angular/core';

/** Clavier d'un `role="menu"` : fleches, Debut/Fin, focus rendu au bouton d'ouverture. */
@Directive({
  selector: '[appMenuKeys]',
  host: {
    '(keydown)': 'onKey($event)',
    '(focusin)': 'hasFocus = true',
    '(focusout)': 'onFocusOut($event)',
  },
})
export class MenuKeys implements OnDestroy {
  readonly appMenuKeys = input.required<HTMLElement>();
  /** Le focus est sorti du menu, par Tab ou par un clic ailleurs. */
  readonly left = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  /** `activeElement` ne sert pas : retire de la page, le menu a deja perdu le focus a la destruction. */
  protected hasFocus = false;

  constructor() {
    // Hors de l'ordre de tabulation : les fleches circulent, Tab sort du menu.
    afterNextRender(() => {
      const items = this.items();
      for (const item of items) item.tabIndex = -1;
      items[0]?.focus();
    });
  }

  private items(): HTMLElement[] {
    return [...this.host.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')];
  }

  protected onKey(ev: KeyboardEvent): void {
    const items = this.items();
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (ev.key) {
      case 'ArrowDown':
        next = (at + 1) % items.length;
        break;
      case 'ArrowUp':
        next = (at - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    ev.preventDefault();
    items[next].focus();
  }

  protected onFocusOut(ev: FocusEvent): void {
    const to = ev.relatedTarget as Node | null;
    if (!to || this.host.contains(to)) return;
    this.hasFocus = false;
    if (!this.appMenuKeys().contains(to)) this.left.emit();
  }

  /** Avant l'ouverture d'un dialogue par l'entree : il prend le focus ensuite et le rendra au bouton. */
  ngOnDestroy(): void {
    if (this.hasFocus) this.appMenuKeys().focus();
  }
}
