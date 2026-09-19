# UJ-04 — Create a Jam from an existing movie

Covers: the "from an existing movie" source, the optional memory field, the resulting room
premise, and the honest labelling that the script is an original work inspired by a real
film.
Runtime: ~5 minutes.
Environment: A or B, with live providers configured for the success path.

## Goal

Prove a room can riff on a movie the participants love without the product presenting the
result as that film, copying it, or letting a catalogue title leak into a generated artifact.

## Preconditions

- Supabase configured; live providers configured for the success path.
- Use the smallest format as in [UJ-03](03-create-jam-from-scratch.md).

## Steps

### 1. Switch the story source

- Do: open `/jams/new`, click `From an existing movie`.
- Expect:
  - `From an existing movie` gets `aria-checked=true`; `From scratch` becomes `false`.
  - The `Opening premise` field disappears.
  - A `Movie title` field appears, labelled required with placeholder `The film your room
    wants to riff on`.
  - An optional field `What the room remembers about it (optional)` appears.
- Evidence: `uj-04-source-switch.png`.

### 2. Validation

- Do: clear `Movie title` and click `Write the script`.
- Expect: blocked; no `POST /api/jams`.
- Do: type a movie title longer than 120 characters.
- Expect: the field caps at 120 characters.

### 3. Fill and submit

- Do:
  - `Jam title` = `UJ Run <date> movie 1`.
  - `Movie title` = `Arrival`.
  - `What the room remembers about it` = `A linguist learns to talk with visitors.`
  - Format: total `0.2`, portions `4`–`4`; visibility `Invite only`.
  - Click `Write the script`.
- Expect the request body:
  - `source.kind` = `from-movie`, `source.movieTitle` = `Arrival`,
    `source.movieSummary` = the memory text.
  - `format.totalSeconds` = `12`.
- Evidence: the request body; `uj-04-submitting.png`.

### 4. Script and room

- Do: wait for `Open the studio`, then read the URL and open the markdown.
- Expect:
  - A script screen identical in structure to UJ-03, with the room title from the form.
  - URL `/jams/<slug>` (the room persisted).
  - The markdown `Source:` line reads `an original story inspired by “Arrival”` and the
    document states it is a generated Movie Jam script, not an existing film or catalogue
    title.
  - No scene portion claims to reproduce the real film's plot, and no catalogue identifier
    (`cat:`) appears anywhere.
- Evidence: `uj-04-script.png`, `uj-04-markdown.png`, `uj-04-url.txt`.

### 5. Inspection for copied material

- Do: read the generated title, logline and at least the first scene. Report, do not judge
  quality.
- Expect: the text is original prose about the room's premise. If it reproduces identifiable
  dialogue or marketing copy from the real film, mark the step `FAIL` and quote at most one
  short line as evidence.
- Evidence: the first scene text.

## Pass criteria

- The from-movie source is sent with the movie title and optional memory.
- The room premise derives from the movie but the artifact is labelled generated.
- No catalogue identifier or real-film claim appears in the generated script.

## Failure signals

- The `Opening premise` field still required while from-movie is selected.
- A generated script that claims to be the real film or carries a `cat:` id.
- The script screen shows the movie title as the script's own title without the inspired-by
  framing.

## Teardown

- Record the slug. Close the markdown page and the create page.

## Not covered

- Catalogue search and discovery (UJ-02).
- Any comparison of the generated story to the real film's plot beyond the leak check.
