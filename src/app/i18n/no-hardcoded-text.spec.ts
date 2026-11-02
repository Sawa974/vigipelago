import { describe, expect, it } from 'vitest';
import app from '../app.html';
import connect from '../ui/connect-screen.html';
import consoleTab from '../ui/console-tab.html';
import dashboard from '../ui/dashboard.html';
import dialog from '../ui/dialog.html';
import language from '../ui/language-dialog.html';
import players from '../ui/players.html';
import theme from '../ui/theme-dialog.html';

/** Les `.html` arrivent en texte via `loader: text` de `angular.json`, que `ng test` reprend. */
const TEMPLATES: Record<string, string> = {
  app,
  connect,
  consoleTab,
  dashboard,
  dialog,
  language,
  players,
  theme,
};

/** Les noms d'exemple de l'apercu des themes. */
const ALLOWED = new Set(['Ada', 'Bob', 'Eve']);

/** Les parentheses s'imbriquent : un compte, pas une expression reguliere. */
function stripControlFlow(html: string): string {
  let out = '';
  for (let i = 0; i < html.length; i++) {
    const m = /^@\w+(\s+if)?\s*/.exec(html.slice(i, i + 40));
    if (!m) {
      out += html[i];
      continue;
    }
    i += m[0].length;
    if (html[i] === '(') {
      for (let depth = 0; i < html.length; i++) {
        if (html[i] === '(') depth++;
        else if (html[i] === ')' && --depth === 0) break;
      }
    } else {
      i--;
    }
    out += ' ';
  }
  return out;
}

function visibleWords(html: string): string[] {
  const text = stripControlFlow(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\{\{[\s\S]*?\}\}/g, ' ')
      // Une balise peut contenir `>` entre guillemets (`[class.x]="n > 1"`).
      .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ' '),
  ).replace(/&\w+;|&#\d+;/g, ' ');
  return (text.match(/\p{L}{2,}/gu) ?? []).filter((w) => !ALLOWED.has(w));
}

function literalAttributes(html: string): string[] {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  return [...noComments.matchAll(/\s(title|placeholder|aria-label)="([^"]*\p{L}[^"]*)"/gu)]
    // Une valeur faite d'une seule interpolation est une donnee, pas un texte.
    .filter((m) => !/^\{\{[^}]*\}\}$/.test(m[2].trim()))
    .map((m) => `${m[1]}="${m[2]}"`);
}

describe('aucun texte en dur dans les gabarits', () => {
  for (const [name, html] of Object.entries(TEMPLATES)) {
    it(`${name} : tout texte affiche passe par une cle`, () => {
      expect(visibleWords(html)).toEqual([]);
      expect(literalAttributes(html)).toEqual([]);
    });
  }

  it('le garde-fou voit bien un texte oublie', () => {
    expect(visibleWords('<p>Bonjour {{ t("x") }}</p>')).toEqual(['Bonjour']);
    expect(literalAttributes('<span title="Une aide">')).toEqual(['title="Une aide"']);
    expect(visibleWords('<!-- commentaire --><b>{{ n }}</b> @if (a) { }')).toEqual([]);
  });
});
