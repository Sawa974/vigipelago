# Translating Vigipelago

Every text of the interface lives in a JSON file: one file per language, one key per text.
English is the reference language and the fallback: a key missing from a translation is
shown in English.

## Use your own language right away

1. Open the menu (☰), then **Language…**.
2. Click **Download the template**: it is the full English file.
3. Translate the values. Never change the keys.
4. Set `lang.code` to your language code (`de`, `es`, `pt-br`…) and `lang.name` to its name in
   that language (`Deutsch`, `Español`…).
5. Back in **Language…**, click **Import a language file**, then pick your language and apply.

The file is checked on import: missing keys fall back to English, unknown keys and malformed
entries are ignored, and the dialog tells you how many of each it found. An imported language
stays in your browser only.

## The format

```json
{
  "lang.code": "de",
  "lang.name": "Deutsch",
  "menu.export": "Exportieren…",
  "count.games": { "one": "{count} Spiel", "other": "{count} Spiele" }
}
```

- **Placeholders** in braces (`{count}`, `{name}`, `{time}`…) are filled in by the tool. Keep
  them, in whatever place your sentence needs them.
- **`{app}`** is always replaced by the name of the tool.
- **Plurals** are objects instead of strings. The forms are the
  [Unicode plural categories](https://cldr.unicode.org/index/cldr-spec/plural-rules) of your
  language: `one` and `other` for most, plus `zero`, `two`, `few` or `many` where the language
  has them. `other` is always required.
- **Archipelago vocabulary** (check, hint, release, collect, slot, DeathLink) is usually kept as
  is: these are the game's own words, the ones players use in every language.
- Messages coming from the Archipelago server are not translated: they are shown as the server
  sends them.

## Add a language to the tool itself

To ship a language with Vigipelago instead of importing it:

1. Add your file as `public/i18n/<code>.json`.
2. In `src/app/i18n/i18n.service.ts`, add the code to `BUILT_IN_LANGUAGES` and its name to
   `BUILT_IN_NAMES`.
3. In `src/app/i18n/i18n.spec.ts`, import the file and add it to the `files` map.
4. Run `npm test`: a test checks that every shipped language has exactly the keys of the
   English reference, with complete plurals.

A pull request with these changes is welcome.
