# Changelog

## 1.0

**Summary table.** The Statistics summary has five fixed columns (player, game, progress, items, deaths), each value
above a gauge. Columns can be hidden, per game.

**Console filters.** *Show only* narrows the console to categories (items, goals, hints, deaths, chat, server) and
to chosen slots, across the whole game history.

**More accurate times** for lines recovered after a gap.

**New to Archipelago?** The home screen links to archipelago.gg.

**Fixes.** Percentages now show two decimals, and many fixes from a full code review.

## 0.12

**One tab listens at a time.** Opening Vigipelago in a second tab no longer cuts off the first one's session. The
second tab shows the same data without listening, and takes over on its own when the first tab closes.

**Accessibility.** The menu ☰ and the playback speed menu work with the keyboard (arrow keys, Home/End, Escape
gives focus back to the button). Confirmations shown in the page are announced by screen readers, and the ⓘ notes
of the Players and Statistics tabs can now be read by them too.

**Fixes**
- A closed session overlapping the live one no longer shows a false gap on the timeline.
- Importing an archive checks every line: a malformed line is skipped and reported instead of being stored.
  Files over 300 MB are refused. Re-importing an archive no longer duplicates its snapshots.
- When the server refuses the connection, Vigipelago stops instead of retrying the same connection in a loop.
- The console no longer shows, live, a line it doesn't keep (a hint announced again, the same text twice within a
  minute): what you see is what comes back after a reload.
- Importing a language file reports when the browser refuses to store it, and refuses files over 1 MB.
- The self-hosted server answers 404 for a missing file instead of the page itself.

**Under the hood**
- A Content Security Policy: the page loads nothing from elsewhere, and the only connections it may open are
  WebSockets, which Vigipelago uses for the server you enter.
- The local database drops seven unused indexes (schema version 7, upgraded automatically).
- Angular 21.2.26 and up-to-date tooling; GitHub Actions pinned by commit.

## 0.11

**Dates and times follow the language.** Menu ☰ → *Language…* now has two more choices, each with an example:
*Dates* (automatic from the language, day/month or month/day) and *Times* (automatic, 24-hour or 12-hour). The
chart axes, the time stamps in lists and the tooltips all follow them.

**Fixes**
- After a network loss, Vigipelago could stay stuck on "Reconnecting" forever, even once the network was back: from
  an `https` page it kept retrying an address the browser blocks. It now reconnects on its own.
- The time spent disconnected is now counted as a gap. Lines recovered on reconnection are dated within the gap
  instead of at the reconnection time, and the timeline shows the interruption.
- The console no longer goes blank while reconnecting.
- Placeholder names (when the server hasn't named an item, location or slot yet) and durations now follow the
  interface language.
- With 12-hour times, the Players lists no longer overflow sideways.

## 0.10

**Catching up other slots is now off by default.** Up to 0.9, when Vigipelago first joined a game and after any
disconnect longer than a minute, it briefly connected as every other slot in the room to recover their checks and
received items, and everyone saw those joins and leaves in the chat. It now only catches up your own slot. To turn
the catch-up of other slots back on for a game: menu ☰ → *Catch-up…* → *All slots*.

**Fixes**
- Catching up other slots now works on servers without TLS.
- Importing an archive no longer skips a hint when another hint from the same player is close in time, and no
  longer duplicates a DeathLink death that two machines timed differently.

## 0.9

First public release.
