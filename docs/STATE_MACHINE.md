# State machines

These describe target behaviour. Currently only draft rooms and active host membership are persisted; transitions, admission and media are not implemented.

## Room lifecycle

`draft → lobby → live → paused → completed | closed`

- **draft**: host configures title, visibility and initial premise.
- **lobby**: invitees choose a name and wait for host admission.
- **live**: participants can chat, propose, vote and watch the current scene evolve.
- **paused**: host temporarily stops transitions while preserving the room.
- **completed**: final production artifacts and replay are available.
- **closed**: active provider handles are released; late events are ignored.

## Participant lifecycle

`joining (UI) → waiting → active → left | removed`

Admission is the authorized transition from `waiting` to `active`, not a separate stored status.

Only an active participant can submit proposals or votes. The host is an active participant with additional configuration, admission, moderation and transition permissions.

## Scene lifecycle

`collecting → voting → accepted → generating → ready → collecting`

While a scene is `generating`, new inputs continue entering the next queue. One accepted turn is committed atomically with its new story version. A failed provider call leaves the committed creative direction intact, marks media as delayed/failed, and offers an explicit retry; it never fabricates a generated scene.

## Media-reference lifecycle

`selected → consented → uploading | live → normalized → available → expired | removed`

An image, clip, or live camera frame becomes available to the story only after its owner declares its purpose and the server validates its type and size. Leaving a live session ends its use as a current reference. Recording or export requires a separate explicit room-level consent state.
