/** Les gabarits lus comme du texte, pour le garde-fou de la traduction. */
declare module '*.html' {
  const content: string;
  export default content;
}
