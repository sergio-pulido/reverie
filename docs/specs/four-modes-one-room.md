# Four modes over one room

Decided 2026-09-20. Not built. Written down so the decision survives the deadline.

## What is wrong today

Everything a person starts is a row in `public.jams`. A Movie Jam room, a Director
session and an escape room are the same row; what tells them apart lives somewhere
else entirely — an escape room has a session in the Node server's memory, a Director
session has rows in `jam_director_sessions`, and both of those are that server's own
routes, absent from a serverless deployment and answerable one jam at a time.

So a list of everything you have started cannot ask what anything is.

`src/lib/startedKinds.ts` works around this by remembering the kind in the browser's
own `localStorage`, and says in its own documentation that this holds only "until the
room's authority holds it". That module names the fix; this document is the fix.

The consequence is visible on the create screens: `/jams/new` and the Director form
are near-identical pages differing by a heading and one field, because nothing in the
product distinguishes what is being made.

## What to build

**One creation, four kinds, one column.** `public.jams` gains a `kind`, constrained to
`jam | director | escape | exam`, written when the row is created and never inferred.
Every place that currently reads `startedKinds.ts` reads the row instead, and that
module is deleted rather than left as a second source that can disagree.

The four:

- **director** — one person, their own film, nobody to wait for.
- **jam** — a room of people steering one film together.
- **escape** — a room deciding what a character does inside an authored world, where a
  rules engine resolves the action and the model only narrates it.
- **exam** — the escape room used for assessment: an examiner states what they want to
  see, a candidate plays, and the examiner reads the decisions back against those
  objectives afterwards. The world stays authored; only the objectives are free text.

`escape` and `exam` share a mechanism and differ in purpose, which is exactly why the
kind belongs on the row and not in the mechanism: the same engine, two products.

**Each kind looks like itself.** The create screen, the card in Yours, the shelf entry
and the room's own detail view are chosen by the kind. Today a person cannot tell from
a screen which of the four they are in, and that is the complaint this answers. The
shared chrome — the bar, the invite, the lobby, the roster, the chat — stays shared;
what changes is what occupies the working area and what the screen asks for.

**The create door already has the shape.** `/create` offers three ways and writes the
choice down. Adding the fourth is adding a card, not a flow.

## Rules this must not break

- **The rules engine stays the authority in `escape` and `exam`.** An examiner writes
  objectives in plain words; they never write the world. A model that can invent what
  happened is not an assessment.
- **A kind is declared, never guessed.** No screen infers the kind from which tables
  happen to have rows; that is the fragility being removed.
- **A room the browser knows nothing about still opens.** Rows written before the
  column exists need a default and a backfill, and the default is `jam`, which is what
  a bare jam row has always meant.
- **The jam's own screen stays the default.** A kind whose extra machinery is
  unreachable — an escape room on a deployment with no Node server — falls back to the
  room rather than to a blank screen. This is the rule the studio fix of 2026-09-20
  established, after a failed escape-room probe blanked the director for every jam.

## Where it touches

`supabase/migrations/` (the column, its constraint, the backfill), `src/lib/jams.ts`,
`src/lib/startedKinds.ts` (deleted), `src/App.tsx`, `src/create/CreateScreen.tsx`,
`src/screens/CreateRoom.tsx`, `src/screens/JamRegistry.tsx` (Yours),
`src/screens/Studio.tsx` (which kind occupies the working area).

## Sequencing

The create screens first, because they need nothing new: the mode is already settled by
the door and held in the app's state, so four faces can be built there without a column,
without a migration and without touching a room that is already running.

The column second, with every reader moved to it in the same change, so there is never a
period with two sources of truth. The per-kind detail views and Yours after that, once
the row can be asked what it is.
