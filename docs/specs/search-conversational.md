# Conversational search at `/discover`

**Status: implemented** (2026-09-19, branch `claude/search`; see `docs/PROJECT_STATE.md`).
`/discover` exists with the empty resting state, turns that carry their films as snapshots, the
preview modal and both of its actions, and filters in their own panel. Where the build differs
from this design: `/discover` no longer browses, it converses, and the top bar's Discover
destination became Search. While the viewer speaks, a pending line in the conversation fills with
the partial transcript, and chips and a poster preview follow what is heard, beyond the plain
field described below. The preview shows no accessibility flags, because no record in the
catalogue carries them.

## Problem

Discover's conversation bar lives inside the grid: the field is always on screen, the transcript
is capped at six text-only lines, and the ranked result of a turn is folded silently into the
grid below. Three things follow from that.

- A viewer who arrives wanting to search sees a wall of titles first and has to find the field.
- The assistant's answer is prose. What it actually recommends — the titles — is never attached
  to the turn that produced it, so "why these?" has no anchor and scrolling away loses the link.
- Text and voice compete for the same narrow strip, so neither gets the room to read from a sofa.

## Screen

`/discover` is its own route with the shared top bar, and it opens **empty**: a single large input,
a voice control beside it, and nothing else — no grid, no shelves, no default results. Silence is
the resting state. The viewer types or speaks, and the screen fills downward from there.

Once a turn has happened the screen is a transcript, newest at the bottom:

- **Viewer turns** are the message as sent, text or transcribed speech alike.
- **Assistant turns** are the acknowledgement, an optional clarifying question, **and the result
  set that turn produced**, rendered inline as a row of poster cards. The posters are the answer,
  not a sidebar to it.
- **System turns** say when the assistant is unavailable or a turn went stale, as they do today.

Earlier turns stay in place with their own posters, so a viewer can scroll back to a recommendation
from three turns ago and it is still there, still clickable.

## The critic's note

The ranking call decides the order and writes a one-line reason for each of the top three. It is
given a catalogue row and forbidden everything outside it, which is why those reasons read like
the genre list read back. A second pass over those three picks — the critic — writes the
recommendation instead, and is sent for what the model knows about the films beyond the row.

For each pick it says three things: **why this one**, **what watching it is like**, and **one
honest reservation**. The reservation is required. A recommendation with nothing against it is
advertising, so a pick the critic cannot fault loses its critique rather than getting a hollow one.

It cannot be fenced by its sources, so it is fenced by what can be checked:

- It writes only about the films it was given. The rest of the row goes with the request as titles
  it is never shown, and naming one refuses the whole reply.
- It states nothing the row contradicts: a running time or a release year that disagrees with the
  record is a refusal, not a flourish.
- It is a recommendation, not an aggregate. No "critics say", no "audiences loved", no invented
  score. Where a row carries a vote average it may cite it once as the crowd's, clearly labelled;
  no list row carries one today, so in practice a score is always a refusal.
- It writes about the film, never about the viewer's preferences. Nothing it says enters the
  preference state, and it never proposes a turn — the grounded-evidence rule is untouched,
  because a critique carries no quote and no evidence to ground.

The checks are about consistency with the catalogue, not truth. A critic asked about a film the
model does not know will write a confident critique of it anyway; the prompt asks it to abstain
and that instruction does not reliably bind. This is a known limit, not a solved problem.

### Where it sits

The critique belongs with its poster, so the viewer can read why this film without leaving the row.

- **At 1920**, a pick's card turns sideways: the poster at its usual size, and beside it why this
  one and the one thing against it, in a slot wide enough for prose that reads from a sofa. What
  watching it is like is the longest of the three and is the preview's.
- **At 390**, a paragraph will not stand beside a 132-pixel poster and three of them will not
  stand under the row. The pick's card widens a little and carries the note's opening lines; the
  whole note, all three parts, opens with the film.

The preview always carries the whole note, above the synopsis: the synopsis says what the film is,
the note says what it is like and what is wrong with it.

### What it costs, and what happens when it fails

One call for the whole set, with its own token ceiling, its own per-attempt timeout and its own
deadline, and at most one retry that is told exactly what was refused. It is asked only once the
films are on screen — a turn hands its films over the moment they are ranked and stays open for
its critique — so the extra call is never in front of the posters and can afford to be slow.

A critic that is refused, times out or is switched off leaves the row exactly as it was: the
reasons the ranking already wrote, and no line in the conversation about the critique. A missing
critique is not worth an apology.

## Result cards

A card is a poster with the title and year beneath it. Selecting one — click, OK on a remote, or
hover after a short dwell on pointer devices — opens a **preview modal** over the transcript:

- backdrop, title, year, runtime, genres, score, the critic's note when the film is one of a
    turn's picks, and the synopsis
- accessibility flags when the record carries them (subtitles, audio description)
- two actions:
  - **Open the film page** → `/discover/:id`, the existing full page, which stays the place where
    everything a film can do will accumulate.
  - **Start a Jam from this** → `/jams/new`, prefilled with a title and premise derived from the
    film. This is the closest thing to "play" that Reverie owns: the catalogue is a discovery
    surface, not a streaming licence, so there is no playback of a catalogue film and the modal
    must not imply one.

The modal is a **preview**, deliberately shallow. It exists so a viewer can triage a row of six
posters without losing the conversation; anything substantial belongs on the film page. Back or
Escape closes it and returns focus to the card it opened from.

Hover-to-open applies to pointer input only and needs a dwell delay, so sweeping the mouse across
a row does not strobe modals open. Keyboard and remote input open on OK, never on focus.

## Voice

The same voice control as Discover, shown as an audio icon and nothing else. Press to record,
press again to stop; the transcript lands in the field where it can be read and corrected, and is
never sent on the viewer's behalf. On this screen the control sits at the input's leading edge and
is sized to be the obvious second way in, not an afterthought beside a text box.

## Filters

Structured refinements (genre, era, runtime) remain available and are applied to the same
shortlist the conversation narrows, so a spoken "something short and funny" and the chips compose
rather than fight. Filters are secondary furniture on this screen: they appear once a turn has
happened, never on the empty state.

## Boundaries

- The engine is unchanged. A turn still goes through the same interpret/rank path, the same
  grounded-evidence rule and the same optimistic-concurrency guard; this screen changes where the
  result is shown, not how it is decided. The critic is a third call and stands outside all of
  that: it reads the state to choose what to say and returns prose, and no path exists by which
  a word of it could become evidence.
- A result set attached to a turn is a **snapshot** of what was recommended then. It is not
  re-ranked when later turns change the state, because a scrollback that silently rewrites itself
  is worse than one that is honestly stale. The critic's notes land in that same snapshot when
  they arrive, which is the one thing that may be added to it: they are written about those very
  picks and change neither which films are there nor the order they are in.
- The transcript's six-line cap does not survive: a searchable history is the point of the screen.
  Bound it by turn count instead, and keep the posters of the turns that remain.
