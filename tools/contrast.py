#!/usr/bin/env python3
"""
Validateur de contraste des themes.

    python tools/contrast.py

Il ne connait aucune couleur : il **lit** `src/styles.css`, donc il ne peut pas mentir sur l'etat reel. Ajouter un theme au CSS suffit a le faire
valider ici.

Ce qu'il verifie, theme par theme :

- la **bande de clarte** — c'est la regle qui rend les themes gratuits. Les couleurs
  porteuses de sens (importance des objets, series, couleurs du protocole) sont validees pour
  un fond donne ; tant qu'un theme garde la clarte du fond de reference et n'en change que la
  teinte, ces validations tiennent par construction. Un theme **clair** sort de la regle et
  demande son propre jeu de couleurs de sens ;
- texte, estompe et accent sur le fond, et le texte pose sur l'accent : 4.5:1, seuil du texte ;
- les couleurs de sens en texte, **sur le fond ET sur la surface** : 4.5:1. Les deux, parce que
  la colonne de gauche et les panneaux posent du texte colore sur `--surface` — un theme peut
  tenir sur son fond et echouer dans son panneau. La surface n'est confrontee qu'aux couleurs
  qui s'y trouvent vraiment (`SENS_SURFACE`) : mesurer tout contre tout inventait des defauts
  sur des combinaisons inexistantes ;
- le bouton destructeur (`--bad` sur `--btn`) et le texte de bouton : 4.5:1 ;
- les huit series et le banal en aplat : 3:1 ;
- les bordures : 1.5, non normatif — c'est le repere de l'outil, mesure sur Ardoise.

Un ECHEC n'interdit rien : il demande une decision. `--log-ts` echoue depuis toujours a 4.12,
c'est connu et assume tant que personne ne l'a tranche.
"""

import re
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
STYLES = RACINE / 'src' / 'styles.css'

# Les couleurs dont le sens est fixe : elles portent du texte, donc 4.5:1.
SENS = [
    'class-progression', 'class-useful', 'class-trap', 'class-filler',
    'c-red', 'c-green', 'c-yellow', 'c-blue', 'c-magenta', 'c-cyan', 'c-white', 'c-black',
    'log-ts', 'log-part', 'ok-text', 'warn-text', 'bad-text',
]
# Aplats : 3:1 suffit, mais il ne faut surtout pas qu'ils se lisent comme du vide.
APLATS = ['series-%d' % i for i in range(1, 9)] + ['class-filler-mark']

# Ce que la SURFACE porte reellement — la colonne de gauche, les panneaux, la barre de saisie.
# La liste est explicite, et c'est tout son interet : mesurer chaque couleur contre chaque fond
# produit des alertes sur des combinaisons qui n'existent nulle part. Les classes d'objet, par
# exemple, ne vivent que dans le flux de la console et sur les barres, donc sur `--bg`.
#
#   c-green / c-cyan / c-yellow / log-ts  pastilles de presence (`.pr-*`, aside)
#   warn-text                             `.cov dd.warn` et `.problems li.warn`
#   bad-text                              `.failed` et `.reasons`
#   muted / text                          libelles et valeurs
SENS_SURFACE = ['c-green', 'c-cyan', 'c-yellow', 'log-ts', 'warn-text', 'bad-text',
                'muted', 'text']

# Quel theme releve de quelle polarite. Miroir de `src/app/core/theme.ts`, qui en est la source.
POLARITE_DE = {'mario-feu': 'claire', 'creme-azur': 'claire'}

SEUIL_TEXTE = 4.5
SEUIL_APLAT = 3.0
REPERE_BORDURE = 1.5


def _lin(c: float) -> float:
    c /= 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hexa: str) -> float:
    h = hexa.lstrip('#')
    if len(h) == 3:
        h = ''.join(ch * 2 for ch in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contraste(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


BLOC = re.compile(
    r"(:root(?:\[data-theme='([a-z0-9-]+)'\])?(?:\[data-polarite='([a-z]+)'\])?|\.viz)"
    r"\s*\{(.*?)\n\}",
    re.S,
)
DECL = re.compile(r'--([a-z0-9-]+)\s*:\s*([^;]+);')


def lire_blocs(chemin: Path) -> list[tuple[str, str, dict[str, str]]]:
    """Rend (theme, polarite, declarations) pour chaque bloc, dans l'ordre du fichier."""
    texte = chemin.read_text(encoding='utf-8')
    out = []
    for m in BLOC.finditer(texte):
        decls = {k: v.strip() for k, v in DECL.findall(m.group(4))}
        if decls:
            out.append((m.group(2) or '', m.group(3) or '', decls))
    return out


def resoudre(jetons: dict[str, str], cle: str, vus: frozenset = frozenset()) -> str | None:
    """Suit les `var(--x)` jusqu'a une valeur hexadecimale. Rend None si ce n'en est pas une."""
    if cle in vus or cle not in jetons:
        return None
    val = jetons[cle]
    ref = re.fullmatch(r'var\(--([a-z0-9-]+)\)', val)
    if ref:
        return resoudre(jetons, ref.group(1), vus | {cle})
    return val if re.fullmatch(r'#[0-9a-fA-F]{3,6}', val) else None


def verdict(valeur: float, seuil: float) -> str:
    return 'OK   ' if valeur >= seuil else 'ECHEC'


def main() -> int:
    blocs = lire_blocs(STYLES)
    base = dict(blocs[0][2])
    # Le jeu de couleurs de sens de chaque polarite, applique avant le decor du theme.
    polarites = {pol: d for nom, pol, d in blocs if pol and not nom}
    themes = [('', {})] + [(nom, d) for nom, _p, d in blocs[1:] if nom]
    reference = luminance(base['bg'])
    echecs = 0

    for nom, surcharge in themes:
        jetons = dict(base)
        pol = POLARITE_DE.get(nom, '')
        if pol:
            jetons.update(polarites.get(pol, {}))
        jetons.update(surcharge)
        bg = resoudre(jetons, 'bg')
        etiquette = nom or 'defaut (:root)'
        print("=== %s — fond %s%s ===" % (etiquette, bg, ', polarite ' + pol if pol else ''))

        clarte = luminance(bg)
        ecart = abs(clarte - reference)
        if pol:
            print('  clarte du fond      %.4f   (polarite %s : jeu de couleurs propre)' % (clarte, pol))
        else:
            print('  clarte du fond      %.4f   (reference %.4f, ecart %.4f)%s'
                  % (clarte, reference, ecart,
                     '' if ecart < 0.01 else '   <- HORS BANDE : les couleurs de sens sont a revalider'))

        for cle, cible, seuil in [('text', bg, SEUIL_TEXTE), ('muted', bg, SEUIL_TEXTE),
                                  ('accent', bg, SEUIL_TEXTE), ('text', resoudre(jetons, 'surface'), SEUIL_TEXTE)]:
            c = resoudre(jetons, cle)
            r = contraste(c, cible)
            echecs += r < seuil
            print('  %-19s %5.2f  %s  (%s sur %s)' % (cle, r, verdict(r, seuil), c, cible))

        r = contraste(resoudre(jetons, 'on-accent'), resoudre(jetons, 'accent'))
        echecs += r < SEUIL_TEXTE
        print('  texte sur accent    %5.2f  %s' % (r, verdict(r, SEUIL_TEXTE)))

        r = contraste(resoudre(jetons, 'border'), bg)
        print('  bordure             %5.2f  %s  (repere %.1f, non normatif)'
              % (r, 'ok' if r >= REPERE_BORDURE else 'faible', REPERE_BORDURE))

        for fond, cles, etiq in ((bg, SENS, 'sur le fond   '),
                                 (resoudre(jetons, 'surface'), SENS_SURFACE, 'sur la surface')):
            rates = [(k, resoudre(jetons, k), contraste(resoudre(jetons, k), fond))
                     for k in cles if resoudre(jetons, k)]
            mauvais = [x for x in rates if x[2] < SEUIL_TEXTE]
            echecs += len(mauvais)
            print('  sens %s  %s' % (etiq,
                  'les %d passent' % len(rates) if not mauvais
                  else 'ECHEC -> ' + ', '.join('%s %s %.2f' % x for x in mauvais)))

        # La colonne de gauche et les panneaux posent du texte colore sur `--surface`, et le
        # bouton destructeur pose `--bad` sur `--btn` : deux fonds que ce validateur ignorait.
        r = contraste(resoudre(jetons, 'bad'), resoudre(jetons, 'btn'))
        echecs += r < SEUIL_TEXTE
        print('  bouton destructeur  %5.2f  %s' % (r, verdict(r, SEUIL_TEXTE)))
        r = contraste(resoudre(jetons, 'text'), resoudre(jetons, 'btn'))
        echecs += r < SEUIL_TEXTE
        print('  texte sur bouton    %5.2f  %s' % (r, verdict(r, SEUIL_TEXTE)))

        rates = [(k, resoudre(jetons, k), contraste(resoudre(jetons, k), bg))
                 for k in APLATS if resoudre(jetons, k)]
        mauvais = [x for x in rates if x[2] < SEUIL_APLAT]
        echecs += len(mauvais)
        print('  aplats (%.1f)         %s' % (SEUIL_APLAT,
              'les %d passent' % len(rates) if not mauvais
              else 'ECHEC -> ' + ', '.join('%s %s %.2f' % x for x in mauvais)))
        print()

    print('%d mesure(s) sous leur seuil.' % echecs)
    return 0


if __name__ == '__main__':
    sys.exit(main())
