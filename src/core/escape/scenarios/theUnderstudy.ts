/**
 * "The Understudy" — an original scenario written for this repository.
 *
 * Weight, rather than power or pressure. The trap is counterweighted and will
 * not lift while a full costume hamper stands on it, and the score the room
 * came for is inside that hamper — so the order is forced without anybody
 * being told it: take the score out first, or the hamper never moves.
 */
export const theUnderstudy = {
  id: "the-understudy",
  title: "The Understudy",
  logline:
    "The fire curtain came down early and left an understudy under the stage with the only copy of a score nobody else remembers.",
  character: {
    name: "June Ferreira",
    description:
      "An understudy who has been at this house four seasons and has never once been on in front of an audience.",
  },
  look:
    "Dust and velvet. Worklight blue from above, warm tungsten from a single practical, everything else in shadow. Slow, close, handheld.",
  startLocationId: "under-stage",
  locations: [
    {
      id: "under-stage",
      name: "under the stage",
      description:
        "A low timber cellar under the boards: counterweight lines, a scenery flat leaning against the wall, and a wicker hamper standing square on the trap.",
      loopShot:
        "Locked-off shot under a theatre stage: low timber beams, counterweight ropes hanging still, a leaning scenery flat, a wicker hamper on the floor. Dust drifts through one blue shaft of worklight from the boards above.",
    },
    {
      id: "wardrobe-nook",
      name: "the wardrobe nook",
      description:
        "A brick alcove behind the flat, hung with dress bags and smelling of naphthalene. Somebody's work table is still laid out on it.",
      loopShot:
        "Slow drift across a brick wardrobe alcove hung with dress bags in the dark. One warm practical lamp on a work table. Dust in the air, nothing moving.",
    },
    {
      id: "orchestra-pit",
      name: "the orchestra pit",
      description:
        "Music stands at all angles, a conductor's rail, and the pit door in the far wall under a dead exit sign.",
      loopShot:
        "Locked-off wide of an empty orchestra pit: music stands at odd angles, a conductor's rail, chairs pushed back. One dead exit sign over a door in the far wall. Blue worklight from overhead.",
    },
  ],
  things: [
    {
      id: "scenery-flat",
      name: "the scenery flat",
      aliases: ["flat", "scenery flat", "canvas flat", "scenery", "panel"],
      description: "A painted canvas flat, two storeys of forest, leaning against the brick and covering the way through.",
      locationId: "under-stage",
      states: [
        { id: "in-place", label: "against the wall", barrier: true },
        { id: "shifted", label: "shifted aside" },
      ],
      initialStateId: "in-place",
    },
    {
      id: "hamper",
      name: "the costume hamper",
      aliases: ["hamper", "basket", "wicker hamper", "costume hamper", "skip"],
      description: "A wicker hamper the size of a bath, strapped shut with two leather belts, standing square on the trap.",
      locationId: "under-stage",
      states: [
        { id: "strapped", label: "strapped shut", barrier: true },
        { id: "open", label: "open" },
        { id: "cleared", label: "dragged clear" },
      ],
      initialStateId: "strapped",
    },
    {
      id: "score",
      name: "the conducting score",
      aliases: ["score", "conducting score", "manuscript", "music", "book"],
      description: "A hand-ruled conducting score in a paper wrapper, annotated by somebody who is dead.",
      locationId: "under-stage",
      states: [{ id: "wrapped", label: "found" }],
      initialStateId: "wrapped",
      known: false,
    },
    {
      id: "trap",
      name: "the stage trap",
      aliases: ["trap", "stage trap", "trapdoor", "trap door", "hatch"],
      description: "A counterweighted trap in the boards overhead, balanced to lift with one hand and carrying a hamper instead.",
      locationId: "under-stage",
      states: [
        { id: "weighted", label: "held down", barrier: true },
        { id: "free", label: "free to lift" },
        { id: "raised", label: "raised" },
      ],
      initialStateId: "weighted",
    },
    {
      id: "shears",
      name: "the wardrobe shears",
      aliases: ["shears", "scissors", "cutters", "wardrobe shears", "blade"],
      description: "Long black wardrobe shears lying open on the work table.",
      locationId: "wardrobe-nook",
      states: [{ id: "laid", label: "to hand" }],
      initialStateId: "laid",
      known: false,
    },
    {
      id: "dress-bags",
      name: "the dress bags",
      aliases: ["dress bags", "bags", "costumes", "dresses", "garment bags"],
      description: "Calico dress bags on a rail, each one labelled with a part and a year.",
      locationId: "wardrobe-nook",
      states: [
        { id: "hanging", label: "unsearched" },
        { id: "searched", label: "searched" },
      ],
      initialStateId: "hanging",
      known: false,
    },
    {
      id: "nook-arch",
      name: "the brick arch",
      aliases: ["arch", "brick arch", "opening", "way back", "under the stage", "cellar"],
      description: "The low brick arch back under the boards.",
      locationId: "wardrobe-nook",
      states: [{ id: "clear", label: "clear" }],
      initialStateId: "clear",
    },
    {
      id: "pit-door",
      name: "the pit door",
      aliases: ["pit door", "door", "exit", "exit door", "stage door"],
      description: "A steel-faced door under a dead exit sign, bolted top and bottom from the inside.",
      locationId: "orchestra-pit",
      states: [
        { id: "bolted", label: "bolted", barrier: true },
        { id: "open", label: "open" },
      ],
      initialStateId: "bolted",
    },
  ],
  actions: [
    {
      id: "shift-flat",
      verbs: ["shift", "move", "slide", "push", "pull", "lift"],
      targetId: "scenery-flat",
      requires: [{ kind: "state", thingId: "scenery-flat", stateId: "in-place", unmet: "The flat is already out of the way." }],
      effects: [
        { kind: "set-state", thingId: "scenery-flat", stateId: "shifted" },
        { kind: "reveal", thingId: "shears" },
        { kind: "reveal", thingId: "dress-bags" },
      ],
      shot: "A painted canvas flat walked sideways along a brick wall on its corner; behind it, a low arch and a warm lamp on a work table.",
      tell: "The flat walks sideways on its corner, and behind it there is an arch, and a lamp somebody left on.",
      seconds: 15,
    },
    {
      id: "enter-nook",
      verbs: ["go behind", "enter", "squeeze past", "go through", "step behind", "go"],
      targetId: "scenery-flat",
      requires: [{ kind: "state", thingId: "scenery-flat", stateId: "shifted", unmet: "The flat is still flush against the brick." }],
      effects: [{ kind: "go", locationId: "wardrobe-nook" }],
      shot: "Squeezing past the edge of a canvas flat into a brick alcove hung with dress bags, warm lamp on a laid-out work table.",
      tell: "She turns sideways past the edge of the canvas and the naphthalene hits her.",
      seconds: 15,
    },
    {
      id: "take-shears",
      verbs: ["take", "pick up", "grab", "get", "lift"],
      targetId: "shears",
      requires: [{ kind: "carrying", thingId: "shears", not: true, unmet: "The shears are already in her hand." }],
      effects: [{ kind: "take", thingId: "shears" }],
      shot: "A hand closes on long black wardrobe shears lying open on a work table beside chalk and pins.",
      tell: "The shears are heavier than they look and still faintly warm from the lamp.",
      seconds: 15,
    },
    {
      id: "return-under-stage",
      verbs: ["go back", "return", "go through", "go under", "enter", "go"],
      targetId: "nook-arch",
      requires: [],
      effects: [{ kind: "go", locationId: "under-stage" }],
      shot: "Ducking back under a low brick arch into a timber cellar; blue worklight from the boards above picks out a wicker hamper.",
      tell: "She ducks back under the arch into the blue.",
      seconds: 15,
    },
    {
      id: "cut-straps",
      verbs: ["cut", "open", "unstrap", "slice", "undo", "unbuckle"],
      targetId: "hamper",
      instrumentId: "shears",
      requires: [
        { kind: "carrying", thingId: "shears", unmet: "The belts are old and drawn tight; fingers will not do it." },
        { kind: "state", thingId: "hamper", stateId: "strapped", unmet: "The hamper is already open." },
      ],
      effects: [
        { kind: "set-state", thingId: "hamper", stateId: "open" },
        { kind: "reveal", thingId: "score" },
      ],
      shot: "Shears working through a drawn leather belt on a wicker hamper; the lid comes up on folded costume and a paper-wrapped manuscript laid flat on top.",
      tell: "The belt parts. Under the lid: folded costume, and on top of it a score in a paper wrapper.",
      seconds: 15,
    },
    {
      id: "take-score",
      verbs: ["take", "lift", "pick up", "grab", "get"],
      targetId: "score",
      requires: [{ kind: "carrying", thingId: "score", not: true, unmet: "She already has the score." }],
      effects: [{ kind: "take", thingId: "score" }],
      shot: "Hands lift a hand-ruled conducting score out of a hamper and turn it to the light; pencil annotation crowded into every margin.",
      tell: "Every margin is crowded with somebody else's pencil. She holds it the way you hold something that cannot be copied.",
      seconds: 15,
    },
    {
      id: "drag-hamper",
      verbs: ["drag", "move", "shove", "push", "pull", "shift", "clear"],
      targetId: "hamper",
      requires: [
        { kind: "state", thingId: "hamper", stateId: "open", unmet: "The hamper is still strapped shut." },
        { kind: "carrying", thingId: "score", unmet: "The score is still in the hamper, and she is not leaving it under a stage." },
      ],
      effects: [
        { kind: "set-state", thingId: "hamper", stateId: "cleared" },
        { kind: "set-state", thingId: "trap", stateId: "free" },
      ],
      shot: "A wicker hamper dragged off a trapdoor across timber, scraping; the boards it uncovers rise a fraction on their own as the weight comes off.",
      tell: "The hamper scrapes off the boards, and the trap lifts a finger's width on its own the moment it is free.",
      seconds: 15,
    },
    {
      id: "lift-trap",
      verbs: ["lift", "open", "raise", "push", "push up"],
      targetId: "trap",
      requires: [{ kind: "state", thingId: "trap", stateId: "free", unmet: "The hamper is still standing on the trap." }],
      effects: [{ kind: "set-state", thingId: "trap", stateId: "raised" }],
      shot: "A counterweighted trapdoor pushed up from below with one hand; it swings away light as a lid, letting blue worklight down the opening.",
      tell: "It goes up like a lid on a box, and the stage opens over her head.",
      seconds: 15,
    },
    {
      id: "climb-through-trap",
      verbs: ["climb", "go up", "go through", "get up", "pull up", "go"],
      targetId: "trap",
      requires: [{ kind: "state", thingId: "trap", stateId: "raised", unmet: "The trap is still down." }],
      effects: [{ kind: "go", locationId: "orchestra-pit" }],
      shot: "Climbing up through a trap opening onto bare stage boards and down the apron into an empty orchestra pit of angled music stands.",
      tell: "The boards are colder than the cellar. She crosses the apron and drops into the pit.",
      seconds: 15,
    },
    {
      id: "unbolt-pit-door",
      verbs: ["unbolt", "open", "unlock", "draw", "undo", "push"],
      targetId: "pit-door",
      requires: [{ kind: "state", thingId: "pit-door", stateId: "bolted", unmet: "The pit door is already open." }],
      effects: [{ kind: "set-state", thingId: "pit-door", stateId: "open" }],
      shot: "Two bolts drawn back top and bottom on a steel-faced door under a dead exit sign; the door opens on a wet alley and street light.",
      tell: "Top bolt, bottom bolt, and the door gives onto an alley and a streetlamp doing its best.",
      seconds: 15,
    },
    {
      id: "search-dress-bags",
      verbs: ["search", "look through", "open", "check", "go through", "read"],
      targetId: "dress-bags",
      requires: [{ kind: "state", thingId: "dress-bags", stateId: "hanging", unmet: "She has already been through them." }],
      effects: [{ kind: "set-state", thingId: "dress-bags", stateId: "searched" }],
      shot: "Calico dress bags pushed along a rail one at a time; handwritten labels swing past — a part, a year, a name repeated four seasons running.",
      tell: "A part and a year on every label. The same name four seasons running, and it is not hers.",
      seconds: 15,
    },
  ],
  goal: {
    description: "Get the conducting score out through the pit door.",
    requires: [
      { kind: "carrying", thingId: "score", unmet: "The score is not in her hands." },
      { kind: "state", thingId: "pit-door", stateId: "open", unmet: "The pit door is still bolted." },
      { kind: "at", locationId: "orchestra-pit", unmet: "She is not in the pit." },
    ],
    tell: "She goes out into the alley with the score inside her coat, and the door closes itself behind her.",
  },
} as const;
