// Cle = THEME_KEY de core/theme.ts. Fichier a part : la CSP bloque les scripts ecrits dans la page.
try {
  var r = document.documentElement;
  var t = localStorage.getItem('vigipelago.theme');
  if (t) r.setAttribute('data-theme', t);
  // Sans la polarite, un theme clair s'afficherait un instant avec le jeu de couleurs
  // sombre : texte clair sur fond clair.
  if (localStorage.getItem('vigipelago.polarite') === 'claire') r.setAttribute('data-polarite', 'claire');
} catch (e) {}
