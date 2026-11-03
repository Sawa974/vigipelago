# Changelog

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
