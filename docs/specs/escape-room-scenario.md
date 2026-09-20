# The escape-room scenario format

Status: implemented. The schema is `src/core/escape/scenario.ts`, the three
scenarios this build ships are `src/core/escape/scenarios/`, and the module
that reads them to decide what happened is `src/core/escape/rules.ts`.

An **escape room** is a Movie Jam with a fixed world and a goal. The room
shares control of one character; the film is what the character does. It
reuses the jam wholesale — invite code, QR, lobby, admission, roster, chat —
and is a configuration of the jam screen rather than a screen of its own.

## Why the world is authored

A scenario is data in this repository, written by a person. Nothing about it
is generated, and that is the point: **the rules decide what happened; the
model only tells it.** Whether the key fits the drawer has to have the same
answer for every participant, every replay and every retry, so it is settled
by a deterministic module with no network, no React, no clock and no
randomness. The model is handed the resolved outcome afterwards and writes the
prose and the shot from it.

Every sentence a participant can be told about why something did not work is
written by the scenario's author. A generic "you cannot do that" is what makes
a room feel arbitrary, so the format has nowhere to put one.

## The shape

```
Scenario
  id, title, logline
  character   { name, description }
  look        held for the whole session, prefixed to every prompt
  startLocationId
  locations   [ { id, name, description, loopShot } ]
  things      [ Thing ]
  actions     [ Action ]
  goal        { description, requires: [Condition], tell }
```

### Locations

A location is a place the character can be in. `description` is read to the
room and grounds every prompt shot there. `loopShot` is the **idle loop**:
one short looping shot generated once per session and played for the rest of
it, so the screen is never dead while the room deliberates. It must describe a
place doing nothing in particular — it plays before the room has chosen
anything, so it can never contain the action that has not happened yet.

There is no "go to the kitchen" verb. Every way between two locations is a
**thing** — a door, a hatch, a stair — whose action carries a `go` effect. A
passage is therefore something that can be shut, found, or refused like
anything else, which is the shape an escape room actually has.

### Things

```
Thing
  id, name, aliases   the words a participant might use
  description
  locationId          where it is; null means it exists only in hand
  states              [ { id, label, barrier } ]
  initialStateId
  known               false for something the room must find first
  carried             true for something the character starts holding
```

`barrier: true` marks a state that is still in the way. The progress panel
counts these; nothing infers "shut" from the name of a state.

A thing's runtime state carries `known` and `seen` separately, and the
difference is load-bearing. `known` means it exists as far as this scenario is
concerned — a hidden thing is not `known` until something reveals it. `seen`
means the character has actually been where it is. A door two rooms away is
`known` but not `seen`, so it does not appear in the progress panel before
anybody has been there, and naming it reads as meaningless rather than as "it
is not here" — which would confirm that the building has one. Arriving
somewhere is what puts its contents on the record, and nothing ever becomes
unseen again.

### Actions

```
Action
  id, verbs            every way a participant might say it
  targetId             what the verb is done to
  instrumentId?        what it is done with
  requires             [ Condition ]
  effects              [ Effect ]
  shot                 the camera; the model is told not to contradict it
  tell                 what happened, in the author's words
  seconds              5–15, the model's own band
```

A **condition** is one fact about the world with the sentence to say when it
does not hold: `at` a location, `carrying` a thing, a thing in a `state`, or a
thing `known`. Each can carry `not: true`, which inverts the fact rather than
adding a mirrored vocabulary of kinds — "she is not already carrying it" is
the same question as "is she carrying it", asked the other way round, and one
flag keeps the two answers from drifting apart.

An **effect** is `set-state`, `take`, `drop`, `reveal` or `go`.

Two actions may share a target with different verbs: shifting a scenery flat
aside and squeezing past it are different things to do to one flat.

## Resolution

`resolveProposal(scenario, state, text)` answers with exactly one of three
outcomes, and only one of them changes the world.

| Outcome | When | What the room is told |
| --- | --- | --- |
| `impossible` | The words reach nothing here: no verb matched, the thing has not been seen, or it is somewhere else. | "Nothing here answers to that", or "The roller door is not here." |
| `failed` | The action is addressable but a requirement is unmet. | The `unmet` sentence its author wrote. |
| `advanced` | Everything holds. | The beat: the author's `tell` and `shot`, and the changes. |

The order of checks is fixed and it matters. **Target presence** is derived
from where the thing is rather than authored, so an author cannot forget it
and ship an action that works through a wall. **Authored requirements** come
next, because an author who wrote a sentence about the missing tool gets to
say it. The **automatic instrument check** is last: the net under an author
who did not.

Interpretation is a deterministic matcher, not a model (`src/core/escape/intent.ts`).
Whether "jam the crank with the file" is the action that frees the shutter is
a question about this world, and questions about this world are answered by
code that is offline and testable. The cost is stated plainly: a phrasing
nobody anticipated does not match, and the room is told so rather than handed
something it did not ask for. `aliases` are how an author widens that.

## The invariants

Three properties are enforced in code and proved in
`tests/escapeRules.test.ts` and `tests/escapeScenarios.test.ts`:

- **An outcome that does not advance returns the very state it was given, by
  identity.** "An impossible action changes nothing" is checkable, not merely
  intended.
- **A replayed action is idempotent.** Opening an already-open hatch fails for
  the author's reason and leaves the world exactly as it was.
- **The goal is reached only by playing into it.** An advancing outcome
  appends exactly one action id to a log. The tests search every scenario
  exhaustively over the transitions the rules actually produce, replay every
  reachable goal log and prove it reproduces that same world, and prove that
  dropping any single step of a shortest solution fails to reach the goal.

A scenario that names a state a thing does not have, a thing that does not
exist or a location that is not declared is refused when the module loads. A
mistyped id would otherwise surface as a paid generation of a beat that
resolves wrong.

## Adding a scenario

1. Write it under `src/core/escape/scenarios/` and export it from that
   directory's `index.ts`. It is parsed at load, so a broken one fails loudly.
2. Give every location a `loopShot` that contains no action.
3. Give every barrier state a `label` a participant can read.
4. `pnpm test` proves it is solvable, that the goal does not hold at the
   start, that every step of a shortest solution is necessary, and that the
   progress panel starts honest.

The scenarios must be original work. Do not write one set inside a known film,
game or book, and do not name or describe a character from one.
