# State machines

## Room lifecycle

`draft → lobby → live → paused → completed | closed`

- **draft**: host configures title, visibility and initial premise.
- **lobby**: invitees choose a name and wait for host admission.
- **live**: participants can chat, propose, vote and watch the current scene evolve.
- **paused**: host temporarily stops transitions while preserving the room.
- **completed**: final production artifacts and replay are available.
- **closed**: active provider handles are released; late events are ignored.

## Participant lifecycle

`joining → waiting → admitted → active → left | removed`

Only an active participant can submit proposals or votes. The host is an active participant with additional configuration, admission, moderation and transition permissions.

## Scene lifecycle

`collecting → voting → accepted → generating → ready → collecting`

While a scene is `generating`, new inputs continue entering the next queue. One accepted turn is committed atomically with its new story version. A failed provider call leaves the committed creative direction intact, marks media as delayed/failed, and offers an explicit retry; it never fabricates a generated scene.
