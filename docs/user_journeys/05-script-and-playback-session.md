# UJ-05 — Script review and per-user playback session

Covers: the generated script screen, its timing labels, the markdown artifact, and the
per-user session that skins playback (language, ambientation) without changing the shared
script. Also covers the owner-token rule that stops one participant editing another's
settings.
Runtime: ~6 minutes.
Environment: A or B, after a successful [UJ-03](03-create-jam-from-scratch.md) or
[UJ-04](04-create-jam-from-existing-movie.md) **in the same page session**.

## Goal

Prove everyone shares one versioned script while each session records its own playback
settings, and that only the owner token can change those settings.

## Preconditions

- A script was just generated and the script screen is open (do **not** reload: the script
  screen only exists in the creating page session; a reload of `/jams/<slug>` opens the
  Studio instead).
- Record the current URL and the jam id used by the `Open as markdown` link.

## Steps

### 1. Script structure matches the requested format

- Do: take a snapshot of the script screen.
- Expect:
  - The eyebrow shows `SCRIPT · <clock> · N SCENES · M PORTIONS` with `clock` equal to the
    requested total (for the smallest format, `0:12`) and the portion count consistent with
    the format.
  - The script's own title is an `<h1>` and the logline follows it.
  - The line `An original generated Movie Jam script — not an existing film or catalogue
    title.`
  - Scene headings `Scene 1 — …`; each portion has `PORTION x.y · start–end · Ns` and an
    action; dialogue and visuals appear only when the script has them.
  - Portion times are contiguous: each `start` equals the previous `end`, starting at
    `0:00`.
- Evidence: `uj-05-script-top.png`, `uj-05-script-portions.png`.

### 2. Markdown artifact

- Do: click `Open as markdown`; read the new page; close it.
- Expect a markdown document with:
  - `# <script title>` and a `>` logline.
  - `- Source: …`, `- Runtime: <clock> (<s>s) across N scenes and M scene portions`.
  - `- This is a generated Movie Jam script, not an existing film or catalogue title.`
  - `### Portion a.b · start–end (Ns)` headings with `**Action.**`, optional `**Dialogue.**`
    and `**Visuals.**`.
- Evidence: `uj-05-markdown.png`.

### 3. Start a playback session

- Do: in the `YOUR SESSION` panel, fill `Your name` = `Host <n>`, set `Language` = `Español`,
  `Ambientation` = `neon-noir rainy metropolis`, click `Start my session`.
- Expect:
  - Exactly one `POST /api/jams/<jam id>/sessions` with
    `{ displayName, settings: { language: "es", ambientation: "neon-noir rainy metropolis" } }`.
  - The response is `201` and includes a `session` and an `ownerToken`. **Treat the owner
    token as a secret: do not screenshot it, paste it or write it into the report.**
  - The panel header becomes `YOUR SESSION · Host <n>`, the heading `Tune your playback.`,
    the button `Save my playback`, and a successful save status `Saved — this jam now plays
    back your way.`
  - A link `My script view` appears.
- Evidence: `uj-05-session-created.png` (do not include the token).

### 4. The session view annotates the shared script

- Do: click `My script view`.
- Expect: the markdown is the same script plus a line
  `- Playback for Host <n>: language es, ambientation “neon-noir rainy metropolis”`. The
  scenes and portions are unchanged from step 2.
- Evidence: `uj-05-session-view.png`.

### 5. Update settings as the owner

- Do: change `Language` to `English`, clear `Ambientation`, click `Save my playback`.
- Expect: a `PATCH /api/sessions/<session id>` with the owner bearer token returns `200`; the
  status message reappears; `My script view` now reads `language en, ambientation as
  written`.
- Evidence: `uj-05-session-updated.png`.

### 6. A non-owner cannot change settings

- Do: `evaluate_script` a `PATCH /api/sessions/<session id>` with body
  `{ settings: { language: "fr" } }` and **no** Authorization header, then again with
  `Authorization: Bearer not-the-owner-token`.
- Expect both: `403 { "status": "error", "code": "not_owner" }` and
  `Only the session owner can change its settings.`
- Do: `GET /api/sessions/<session id>` with no token.
- Expect: `200` with a public session projection that contains **no** `ownerToken`.
- Evidence: both JSON bodies.

### 7. Unknown routes fail honestly

- Do: `GET /api/sessions/00000000-0000-0000-0000-000000000000` and a malformed id.
- Expect: a typed `404 not_found` (or `400 invalid_command` for a malformed body), never a
  stack trace or HTML.

## Pass criteria

- The script the room shares is structurally identical for every viewer.
- A session records language/ambientation and never mutates the script.
- The owner token is returned once, required to update, and never listed or leaked.
- Editing settings without the token is refused.

## Failure signals

- A second session creation overwrote the first without a new owner token.
- The owner token appears in a list route, a URL, or a log.
- A non-owner `PATCH` succeeds.
- Portion timings drift or overlap.

## Teardown

- Close the markdown page. Keep the script page if the next journey needs it; otherwise
  leave via `Open the studio` (UJ-06) or close the page.

## Not covered

- Real translated or re-ambiented media generation (not implemented; sessions only record
  parameters).
- Session persistence across server restart (in-memory store).
