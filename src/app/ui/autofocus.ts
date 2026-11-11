import { afterNextRender, Directive, ElementRef, inject } from '@angular/core';

/** L'attribut `autofocus` ne vaut qu'une fois par document : un bloc insere plus tard l'ignore. */
@Directive({ selector: '[appAutofocus]' })
export class Autofocus {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => el.focus());
  }
}
