/**
 * "The Night Audit" — an original scenario written for this repository.
 *
 * Municipal, fluorescent and bureaucratic: a building that has quietly
 * decided the character was never in it. The spine is one dependency the
 * room has to discover rather than be told — killing the power opens the
 * magnetic lock and takes the lights with it, so the torch stops being
 * scenery and becomes the reason the next step works.
 */
export const nightAudit = {
  id: "night-audit",
  title: "The Night Audit",
  logline:
    "A night auditor has until the shredding van arrives to carry one sealed ledger out of a building that has already filed her as gone home.",
  character: {
    name: "Marit Kessel",
    description:
      "A night auditor in a borrowed coat: precise, tired, and about four hours past the point where she could simply have left.",
  },
  look:
    "Municipal night. Green-white fluorescent, rain on the glass, grey steel and wet concrete. Handheld, unhurried, held at waist height.",
  startLocationId: "reading-room",
  locations: [
    {
      id: "reading-room",
      name: "the reading room",
      description:
        "A public reading room after hours: eight empty tables, a dead vending machine, and a counter with a hatch somebody forgot to lock.",
      loopShot:
        "Locked-off wide of an empty municipal reading room at night. Fluorescent tubes tick and flicker over eight bare tables. Rain runs down the window behind the counter. Nothing moves.",
    },
    {
      id: "stacks",
      name: "the stacks",
      description:
        "Rolling steel shelving on floor rails, packed to the ceiling with box files. One aisle is wound open; the rest are shut tight against each other.",
      loopShot:
        "Slow drift down a narrow aisle of steel shelving packed with box files. Dust turns in the beam of a single emergency light. The shelves shift a fraction as the building settles.",
    },
    {
      id: "loading-bay",
      name: "the loading bay",
      description:
        "Cold concrete that smells of diesel. A roller door faces the yard, and a clipboard hangs on a nail where a guard should be.",
      loopShot:
        "Locked-off shot of a cold concrete loading bay. A barred roller door, a clipboard on a nail, one sodium lamp outside laying orange across the floor. Rain at the edge of frame.",
    },
  ],
  things: [
    {
      id: "counter-hatch",
      name: "the counter hatch",
      aliases: ["hatch", "counter", "counter hatch", "the hatch"],
      description: "A hinged flap in the enquiries counter, shut but not locked.",
      locationId: "reading-room",
      states: [
        { id: "shut", label: "shut", barrier: true },
        { id: "open", label: "open" },
      ],
      initialStateId: "shut",
    },
    {
      id: "torch",
      name: "the torch",
      aliases: ["torch", "flashlight", "lamp", "hand torch"],
      description: "A rubber-cased torch with a cracked lens, kept under the counter for power cuts.",
      locationId: "reading-room",
      states: [
        { id: "off", label: "unlit" },
        { id: "on", label: "lit" },
      ],
      initialStateId: "off",
      known: false,
    },
    {
      id: "fuse-box",
      name: "the fuse box",
      aliases: ["fuse box", "fusebox", "breakers", "breaker panel", "fuses"],
      description: "A grey steel panel by the stack door, its cover held by a single wing nut.",
      locationId: "reading-room",
      states: [
        { id: "closed", label: "closed" },
        { id: "open", label: "open" },
        { id: "thrown", label: "thrown" },
      ],
      initialStateId: "closed",
    },
    {
      id: "lights",
      name: "the lights",
      aliases: ["lights", "the lighting", "strip lights", "fluorescents"],
      description: "Fluorescent tubes the length of the ceiling, running off the same board as the door.",
      locationId: "reading-room",
      states: [
        { id: "on", label: "on" },
        { id: "out", label: "out" },
      ],
      initialStateId: "on",
    },
    {
      id: "stack-door",
      name: "the stack door",
      aliases: ["stack door", "stacks door", "steel door", "door to the stacks", "stacks"],
      description: "A steel door with a push bar and a magnetic lock that holds while the board has power.",
      locationId: "reading-room",
      states: [
        { id: "held", label: "magnetically locked", barrier: true },
        { id: "free", label: "unlocked" },
      ],
      initialStateId: "held",
    },
    {
      id: "shelving",
      name: "the rolling shelving",
      aliases: ["shelving", "shelves", "rolling shelves", "crank", "hand crank", "aisle"],
      description: "Six ranges of shelving on floor rails, wound together so tightly a hand will not fit between them.",
      locationId: "stacks",
      states: [
        { id: "shut", label: "wound shut", barrier: true },
        { id: "open", label: "wound open" },
      ],
      initialStateId: "shut",
    },
    {
      id: "ledger",
      name: "the sealed ledger",
      aliases: ["ledger", "sealed ledger", "buckram ledger", "book"],
      description: "A buckram ledger closed with a paper band, stamped for destruction on a date that is today.",
      locationId: "stacks",
      states: [{ id: "shelved", label: "found" }],
      initialStateId: "shelved",
      known: false,
    },
    {
      id: "crowbar",
      name: "the crowbar",
      aliases: ["crowbar", "pry bar", "prybar", "bar", "jemmy"],
      description: "A short crowbar left behind the ranges by whoever last moved the rails.",
      locationId: "stacks",
      states: [{ id: "idle", label: "to hand" }],
      initialStateId: "idle",
      known: false,
    },
    {
      id: "service-stair",
      name: "the service stair",
      aliases: ["service stair", "stair", "stairs", "staircase", "steps", "loading bay", "bay"],
      description: "A bare concrete stair behind the last range, dropping to the loading bay.",
      locationId: "stacks",
      states: [{ id: "clear", label: "clear" }],
      initialStateId: "clear",
      known: false,
    },
    {
      id: "clipboard",
      name: "the clipboard",
      aliases: ["clipboard", "board", "sign-in sheet", "sheet", "log"],
      description: "A clipboard on a nail, holding the yard's collection sheet for the morning.",
      locationId: "loading-bay",
      states: [
        { id: "hanging", label: "unread" },
        { id: "read", label: "read" },
      ],
      initialStateId: "hanging",
    },
    {
      id: "roller-door",
      name: "the roller door",
      aliases: ["roller door", "shutter", "loading door", "yard door", "roller shutter"],
      description: "A corrugated roller door barred across the bottom rail with a steel drop bolt.",
      locationId: "loading-bay",
      states: [
        { id: "barred", label: "barred", barrier: true },
        { id: "open", label: "open" },
      ],
      initialStateId: "barred",
    },
  ],
  actions: [
    {
      id: "open-hatch",
      verbs: ["open", "lift", "raise", "look under", "search"],
      targetId: "counter-hatch",
      requires: [{ kind: "state", thingId: "counter-hatch", stateId: "shut", unmet: "The hatch is already up." }],
      effects: [
        { kind: "set-state", thingId: "counter-hatch", stateId: "open" },
        { kind: "reveal", thingId: "torch" },
      ],
      shot: "Close on a counter hatch lifting on its hinge; the shelf underneath holds a rubber-cased torch and a tin of drawing pins.",
      tell: "The hatch lifts without complaint. Underneath: drawing pins, an expired pass, and a torch.",
      seconds: 15,
    },
    {
      id: "take-torch",
      verbs: ["take", "pick up", "grab", "pocket", "get"],
      targetId: "torch",
      requires: [{ kind: "carrying", thingId: "torch", not: true, unmet: "She already has the torch." }],
      effects: [{ kind: "take", thingId: "torch" }],
      shot: "Hands lift a rubber-cased torch off a shelf and test its weight; the cracked lens catches the strip light.",
      tell: "She takes the torch and tests the weight of it against her palm.",
      seconds: 15,
    },
    {
      id: "open-fuse-box",
      verbs: ["open", "unscrew", "undo", "look in", "check"],
      targetId: "fuse-box",
      requires: [{ kind: "state", thingId: "fuse-box", stateId: "closed", unmet: "The cover is already off." }],
      effects: [{ kind: "set-state", thingId: "fuse-box", stateId: "open" }],
      shot: "A wing nut turns under a thumb and a grey steel cover swings back off a fuse board; rows of labelled breakers, one of them marked in biro.",
      tell: "The wing nut turns. Behind the cover, rows of breakers, one labelled in biro: ANNEXE — DOORS.",
      seconds: 15,
    },
    {
      id: "throw-breaker",
      verbs: ["throw", "cut", "kill", "flip", "switch off", "trip", "pull"],
      targetId: "fuse-box",
      requires: [{ kind: "state", thingId: "fuse-box", stateId: "open", unmet: "The cover is still on the fuse box." }],
      effects: [
        { kind: "set-state", thingId: "fuse-box", stateId: "thrown" },
        { kind: "set-state", thingId: "stack-door", stateId: "free" },
        { kind: "set-state", thingId: "lights", stateId: "out" },
      ],
      shot: "A hand throws a breaker. The fluorescent tubes go out the length of the ceiling in one stroke and the room drops to rain-light from the window.",
      tell: "The breaker goes over. Every tube in the ceiling dies at once, and somewhere behind her a magnetic lock lets go.",
      seconds: 15,
    },
    {
      id: "light-torch",
      verbs: ["switch on", "turn on", "light", "click on", "use"],
      targetId: "torch",
      requires: [
        { kind: "carrying", thingId: "torch", unmet: "The torch is not in her hand." },
        { kind: "state", thingId: "torch", stateId: "off", unmet: "The torch is already lit." },
      ],
      effects: [{ kind: "set-state", thingId: "torch", stateId: "on" }],
      shot: "A thumb finds a rubber switch in the dark; a narrow beam opens across empty tables and catches rain-shadow on the wall.",
      tell: "The switch gives, and a narrow beam opens across the tables.",
      seconds: 15,
    },
    {
      id: "enter-stacks",
      verbs: ["open", "push", "go through", "enter", "go into", "walk into"],
      targetId: "stack-door",
      requires: [
        { kind: "state", thingId: "stack-door", stateId: "free", unmet: "The magnetic lock is still holding the door shut." },
        { kind: "state", thingId: "torch", stateId: "on", unmet: "Past that door there are no windows at all, and the torch is not lit." },
        { kind: "carrying", thingId: "torch", unmet: "She is not carrying anything to see by." },
      ],
      effects: [{ kind: "go", locationId: "stacks" }],
      shot: "A push bar gives and a steel door swings into absolute dark; a torch beam goes in ahead of her and finds the ends of steel shelving ranges.",
      tell: "The push bar gives. The beam goes in first and finds the ends of the ranges, one after another.",
      seconds: 15,
    },
    {
      id: "wind-shelving",
      verbs: ["wind", "crank", "turn", "open", "push apart", "roll"],
      targetId: "shelving",
      requires: [{ kind: "state", thingId: "shelving", stateId: "shut", unmet: "That aisle is already wound open." }],
      effects: [
        { kind: "set-state", thingId: "shelving", stateId: "open" },
        { kind: "reveal", thingId: "ledger" },
        { kind: "reveal", thingId: "crowbar" },
        { kind: "reveal", thingId: "service-stair" },
      ],
      shot: "A hand crank turns and a whole range of steel shelving rolls sideways on its rail, opening an aisle; the torch beam runs down it to a concrete stair at the far end.",
      tell: "The crank takes both hands. The range rolls back and the aisle opens: box files, a crowbar somebody left on the rail, and a stair at the far end.",
      seconds: 15,
    },
    {
      id: "take-ledger",
      verbs: ["take", "pick up", "grab", "pull", "get", "lift"],
      targetId: "ledger",
      requires: [{ kind: "carrying", thingId: "ledger", not: true, unmet: "She already has the ledger under her arm." }],
      effects: [{ kind: "take", thingId: "ledger" }],
      shot: "A buckram ledger slides out from between box files; a paper band across it reads a destruction date in red.",
      tell: "The ledger comes out heavier than it looks. The band across it is stamped with today's date.",
      seconds: 15,
    },
    {
      id: "take-crowbar",
      verbs: ["take", "pick up", "grab", "get", "lift"],
      targetId: "crowbar",
      requires: [{ kind: "carrying", thingId: "crowbar", not: true, unmet: "The crowbar is already in her hand." }],
      effects: [{ kind: "take", thingId: "crowbar" }],
      shot: "A short crowbar is lifted off a floor rail, painted rust-red, one end worn bright.",
      tell: "She takes the crowbar. One end of it is worn bright by somebody else's evening.",
      seconds: 15,
    },
    {
      id: "take-stair",
      verbs: ["go down", "take", "descend", "go", "climb down", "follow"],
      targetId: "service-stair",
      requires: [],
      effects: [{ kind: "go", locationId: "loading-bay" }],
      shot: "A torch beam goes down a bare concrete stair ahead of two feet; at the bottom, cold air and the orange of a yard lamp under a roller door.",
      tell: "The stair is bare concrete and colder with every step. At the bottom, diesel and orange light.",
      seconds: 15,
    },
    {
      id: "pry-roller-door",
      verbs: ["pry", "lever", "prise", "force", "open", "jemmy", "lift"],
      targetId: "roller-door",
      instrumentId: "crowbar",
      requires: [
        { kind: "carrying", thingId: "crowbar", unmet: "The drop bolt will not move by hand." },
        { kind: "state", thingId: "roller-door", stateId: "barred", unmet: "The roller door is already up." },
      ],
      effects: [{ kind: "set-state", thingId: "roller-door", stateId: "open" }],
      shot: "A crowbar goes under a steel drop bolt and both arms put weight on it; the bolt jumps, and the corrugated door runs up a foot and stops, showing wet yard.",
      tell: "The bolt jumps out of its socket and the door runs up a foot, letting in rain and the sound of the yard.",
      seconds: 15,
    },
    {
      id: "read-clipboard",
      verbs: ["read", "look at", "check", "examine", "take", "turn over"],
      targetId: "clipboard",
      requires: [{ kind: "state", thingId: "clipboard", stateId: "hanging", unmet: "She has already read it." }],
      effects: [{ kind: "set-state", thingId: "clipboard", stateId: "read" }],
      shot: "Close on a clipboard lifted off a nail under a sodium lamp; a collection sheet, a time in the morning column, and a signature nobody would be able to read.",
      tell: "Collection at six. The signature under it is hers, in a hand that is not.",
      seconds: 15,
    },
  ],
  goal: {
    description: "Get the sealed ledger out through the loading bay.",
    requires: [
      { kind: "carrying", thingId: "ledger", unmet: "The ledger is still in the building." },
      { kind: "state", thingId: "roller-door", stateId: "open", unmet: "The roller door is still barred." },
      { kind: "at", locationId: "loading-bay", unmet: "She is not at the loading bay." },
    ],
    tell: "She goes under the door sideways with the ledger held against her chest, and the rain takes her.",
  },
} as const;
