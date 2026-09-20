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

## Result cards

A card is a poster with the title and year beneath it. Selecting one — click, OK on a remote, or
hover after a short dwell on pointer devices — opens a **preview modal** over the transcript:

- backdrop, title, year, runtime, genres, score, and the synopsis
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

## What the film is about

A turn may carry, besides its genre, runtime and era decisions, a **subject**: the words in the
viewer's own message that say what the film is about. It is the only part of a request that is
not a category, and it exists because the catalogue can honour it — `catalogue_titles.document`
is a weighted full-text vector over title (A), genres (B), keywords (C) and overview (D), with a
GIN index, and `search_catalogue_titles` already takes a `search` argument.

- **It is the viewer's words, never the model's.** The engine grounds it the way it grounds every
  other decision, one word at a time: a search phrase is the sentence with the filler between the
  words left out, so it is rarely a literal substring, but every word of it must be a word of the
  message. A phrase carrying one invented word refuses the whole turn — the same refusal, with
  the same code, as an ungrounded quote — rather than being quietly dropped.
- **A subject is not a genre.** "A family with some pets" says what the film is about; it is not
  the Family genre, and the interpret prompt says so outright. The two vocabularies do not
  overlap, so naming a subject never silently narrows by category.
- **How it composes.** A later subject replaces the one in effect. A turn that says nothing about
  the subject — a genre, a running time, an era, a chip from the filter panel — leaves the
  standing one alone. Withdrawing it from the narrowing strip clears it and nothing else.
- **It narrows; it does not rank.** The phrase goes to the database as the `search` argument and
  chooses which titles are shortlisted at all. The ranking step is unchanged: the assistant still
  reorders exactly the shortlist it is handed, and the strip's count and the filter panel are
  still the deterministic scorer's.
- **It is in the strip like everything else.** The state's subject appears first in the narrowing
  strip as *About "…"*, removable by the same press as a genre or an era.

### When the words match nothing

A subject that matches no film must not empty the screen. The read falls back to the structured
filters alone — the filters are never dropped, only the words, and only when they would otherwise
leave the viewer with nothing — and the row says plainly *The words "…" found no films, so these
match everything else you asked for.* A broader answer is never mistaken for the one that was
asked for.

### Where it is not checked

The preference engine cannot judge a subject against a candidate: nothing a candidate carries is
prose, so there is no eligibility rule it could feed. It is grounded and composed in the engine
and applied by whatever retrieves the candidates. That is why it is a field of its own rather
than a constraint — a constraint the engine could not evaluate would pass everything and look
like it had filtered.

## Boundaries

- The engine's shape is unchanged. A turn still goes through the same interpret/rank path, the
  same grounded-evidence rule and the same optimistic-concurrency guard; this screen changes
  where the result is shown, not how it is decided. The subject added one field to the state and
  one grounding rule beside the existing one, and touched nothing else.
- A result set attached to a turn is a **snapshot** of what was recommended then. It is not
  re-ranked when later turns change the state, because a scrollback that silently rewrites itself
  is worse than one that is honestly stale.
- The transcript's six-line cap does not survive: a searchable history is the point of the screen.
  Bound it by turn count instead, and keep the posters of the turns that remain.
