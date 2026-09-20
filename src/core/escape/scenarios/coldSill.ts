/**
 * "Cold Sill" — an original scenario written for this repository.
 *
 * Pressure, not power. The spine is that the bulkhead cannot be undogged
 * while the porch is still filling: the room has to notice that stopping the
 * water is what makes the next door possible, and the door refuses with a
 * sentence that says exactly why.
 */
export const coldSill = {
  id: "cold-sill",
  title: "Cold Sill",
  logline:
    "A habitat technician has one ascent bell, a rising wet porch, and a core sample that is the only reason anybody was down here.",
  character: {
    name: "Ozan Rills",
    description:
      "A habitat technician eleven days into a fourteen-day rotation, calm in the way of someone who has already worked out how bad this is.",
  },
  look:
    "Seabed industrial. Yellow work light through green water, wet steel, condensation on every surface. Slow, close, the camera breathing with him.",
  startLocationId: "wet-porch",
  locations: [
    {
      id: "wet-porch",
      name: "the wet porch",
      description:
        "A steel box half-full of black water, lit yellow from one caged lamp. The sea comes in through a flood valve nobody has been able to reach for a week.",
      loopShot:
        "Locked-off shot inside a flooded steel wet porch on the seabed. One caged yellow lamp. Black water rocking against the walls, condensation running down painted steel, a slow curtain of bubbles from a valve below the surface.",
    },
    {
      id: "plant-room",
      name: "the plant room",
      description:
        "Pipework, a gas rack, and a sample locker bolted to the deck. Dry, and loud with the sound of pumps that are losing.",
      loopShot:
        "Slow push through a cramped undersea plant room: pipework, a gas rack, sweating steel. A single work lamp swings a fraction on its cable. Nothing else moves.",
    },
    {
      id: "bell-trunk",
      name: "the bell trunk",
      description:
        "A vertical steel shaft with the ascent bell stowed in its collar overhead, salt-crusted and last serviced in another decade.",
      loopShot:
        "Looking up a narrow vertical steel trunk at a stowed ascent bell crusted with salt. Rust water drips past the lens. A lamp somewhere below throws the shadow of the ladder up the wall.",
    },
  ],
  things: [
    {
      id: "spanner",
      name: "the deck spanner",
      aliases: ["spanner", "wrench", "deck spanner", "tool"],
      description: "A long deck spanner clipped to the porch wall above the waterline.",
      locationId: "wet-porch",
      states: [{ id: "clipped", label: "to hand" }],
      initialStateId: "clipped",
    },
    {
      id: "flood-valve",
      name: "the flood valve",
      aliases: ["flood valve", "valve", "handwheel", "wheel", "inlet"],
      description: "A handwheel below the waterline, seized with a week of salt.",
      locationId: "wet-porch",
      states: [
        { id: "open", label: "open", barrier: true },
        { id: "shut", label: "shut" },
      ],
      initialStateId: "open",
    },
    {
      id: "water",
      name: "the water",
      aliases: ["water", "sea", "flood", "level"],
      description: "Black water, coming up the porch wall a finger's width a minute.",
      locationId: "wet-porch",
      states: [
        { id: "rising", label: "rising", barrier: true },
        { id: "still", label: "still" },
      ],
      initialStateId: "rising",
    },
    {
      id: "bulkhead",
      name: "the bulkhead door",
      aliases: ["bulkhead", "bulkhead door", "dogs", "hatch", "inner door", "plant room"],
      description: "A dogged bulkhead door to the plant room, held by six levers and the difference in pressure behind them.",
      locationId: "wet-porch",
      states: [
        { id: "dogged", label: "dogged shut", barrier: true },
        { id: "swung", label: "swung open" },
      ],
      initialStateId: "dogged",
    },
    {
      id: "sample-locker",
      name: "the sample locker",
      aliases: ["sample locker", "locker", "cabinet", "sample cabinet"],
      description: "A deck-bolted locker with a toggle catch, stencilled with a core number.",
      locationId: "plant-room",
      states: [
        { id: "shut", label: "shut", barrier: true },
        { id: "open", label: "open" },
      ],
      initialStateId: "shut",
    },
    {
      id: "sample-case",
      name: "the sample case",
      aliases: ["sample case", "sample", "core", "case", "canister", "core sample"],
      description: "A pressure case the size of a forearm, holding eleven days of seabed core.",
      locationId: "plant-room",
      states: [
        { id: "held", label: "in hand" },
        { id: "aboard", label: "aboard the bell" },
      ],
      initialStateId: "held",
      known: false,
    },
    {
      id: "gas-rack",
      name: "the gas rack",
      aliases: ["gas rack", "rack", "bottles", "cylinders", "gas"],
      description: "Four gas bottles strapped in a rack, contents gauges facing the wrong way.",
      locationId: "plant-room",
      states: [
        { id: "unchecked", label: "unchecked" },
        { id: "checked", label: "checked" },
      ],
      initialStateId: "unchecked",
    },
    {
      id: "ladder",
      name: "the trunk ladder",
      aliases: ["ladder", "trunk ladder", "rungs", "trunk", "bell trunk", "shaft"],
      description: "Welded rungs going up the trunk to the bell collar.",
      locationId: "plant-room",
      states: [{ id: "clear", label: "clear" }],
      initialStateId: "clear",
      known: false,
    },
    {
      id: "bell-hatch",
      name: "the bell hatch",
      aliases: ["bell hatch", "hatch", "bell", "ascent bell", "collar"],
      description: "The ascent bell's hatch, seized into its collar with a decade of salt.",
      locationId: "bell-trunk",
      states: [
        { id: "seized", label: "salt-seized", barrier: true },
        { id: "free", label: "free" },
      ],
      initialStateId: "seized",
    },
    {
      id: "ballast",
      name: "the ballast release",
      aliases: ["ballast", "ballast release", "release", "lever", "drop weights", "weights"],
      description: "A red lever inside the bell collar that lets the weights go and sends it up.",
      locationId: "bell-trunk",
      states: [
        { id: "set", label: "set", barrier: true },
        { id: "blown", label: "blown" },
      ],
      initialStateId: "set",
    },
  ],
  actions: [
    {
      id: "take-spanner",
      verbs: ["take", "grab", "unclip", "pick up", "get"],
      targetId: "spanner",
      requires: [{ kind: "carrying", thingId: "spanner", not: true, unmet: "The spanner is already in his hand." }],
      effects: [{ kind: "take", thingId: "spanner" }],
      shot: "A wet hand unclips a long deck spanner from a painted steel wall above a black waterline.",
      tell: "He unclips the spanner. It is colder than the water.",
      seconds: 15,
    },
    {
      id: "shut-flood-valve",
      verbs: ["shut", "close", "turn", "crank", "wind", "stop", "seal"],
      targetId: "flood-valve",
      instrumentId: "spanner",
      requires: [
        { kind: "carrying", thingId: "spanner", unmet: "The handwheel is seized; a bare hand will not shift it." },
        { kind: "state", thingId: "flood-valve", stateId: "open", unmet: "The valve is already shut." },
      ],
      effects: [
        { kind: "set-state", thingId: "flood-valve", stateId: "shut" },
        { kind: "set-state", thingId: "water", stateId: "still" },
      ],
      shot: "Underwater: a spanner set across a handwheel, both arms hauling, the wheel giving a quarter turn at a time until the curtain of bubbles stops.",
      tell: "The wheel gives a quarter turn, then another, and the bubbles stop. The water holds where it is.",
      seconds: 15,
    },
    {
      id: "undog-bulkhead",
      verbs: ["undog", "open", "unlatch", "release", "throw", "unlock"],
      targetId: "bulkhead",
      requires: [
        { kind: "state", thingId: "water", stateId: "still", unmet: "The porch is still filling; the pressure behind the door will not let the dogs move." },
        { kind: "state", thingId: "bulkhead", stateId: "dogged", unmet: "The bulkhead is already swung open." },
      ],
      effects: [{ kind: "set-state", thingId: "bulkhead", stateId: "swung" }],
      shot: "Six dog levers thrown one after another around a steel bulkhead; on the last, the door sighs off its seal and swings a hand's width.",
      tell: "The dogs go over one by one, and on the sixth the door sighs off its seal.",
      seconds: 15,
    },
    {
      id: "enter-plant-room",
      verbs: ["go through", "enter", "step through", "go", "climb through", "pass"],
      targetId: "bulkhead",
      requires: [{ kind: "state", thingId: "bulkhead", stateId: "swung", unmet: "The bulkhead is still dogged shut." }],
      effects: [{ kind: "go", locationId: "plant-room" }],
      shot: "A body folds through a bulkhead opening out of black water into a dry, loud plant room of pipework and sweating steel.",
      tell: "He folds through into noise and dry air, and the water stays behind him.",
      seconds: 15,
    },
    {
      id: "open-locker",
      verbs: ["open", "unlatch", "pop", "undo", "force"],
      targetId: "sample-locker",
      requires: [{ kind: "state", thingId: "sample-locker", stateId: "shut", unmet: "The locker is already open." }],
      effects: [
        { kind: "set-state", thingId: "sample-locker", stateId: "open" },
        { kind: "reveal", thingId: "sample-case" },
        { kind: "reveal", thingId: "ladder" },
      ],
      shot: "A toggle catch flips and a deck-bolted locker opens on a foam bed holding one pressure case; behind it, welded rungs going up into a dark trunk.",
      tell: "The catch flips. The case is sitting in its foam exactly where it should be, and behind the locker the trunk ladder goes up into the dark.",
      seconds: 15,
    },
    {
      id: "take-sample-case",
      verbs: ["take", "lift", "pick up", "grab", "get"],
      targetId: "sample-case",
      requires: [{ kind: "carrying", thingId: "sample-case", not: true, unmet: "He already has the case." }],
      effects: [{ kind: "take", thingId: "sample-case" }],
      shot: "Two hands lift a forearm-length pressure case out of grey foam; stencilled numbers, a bright new dent in the lid.",
      tell: "The case comes out of its foam. Eleven days, and it weighs almost nothing.",
      seconds: 15,
    },
    {
      id: "climb-ladder",
      verbs: ["climb", "go up", "ascend", "take", "go"],
      targetId: "ladder",
      requires: [],
      effects: [{ kind: "go", locationId: "bell-trunk" }],
      shot: "Climbing welded rungs up a narrow steel trunk, lamp light falling away below, rust water running past the lens.",
      tell: "The rungs are wet and the trunk is narrow enough to brace against with both shoulders.",
      seconds: 15,
    },
    {
      id: "free-bell-hatch",
      verbs: ["strike", "hit", "hammer", "knock", "free", "beat", "open"],
      targetId: "bell-hatch",
      instrumentId: "spanner",
      requires: [
        { kind: "carrying", thingId: "spanner", unmet: "Salt has welded the hatch into its collar; a hand alone will not start it." },
        { kind: "state", thingId: "bell-hatch", stateId: "seized", unmet: "The hatch is already free." },
      ],
      effects: [{ kind: "set-state", thingId: "bell-hatch", stateId: "free" }],
      shot: "A spanner hammered around the rim of a salt-crusted hatch; crust breaking away in white flakes until the hatch turns a few degrees and stops.",
      tell: "He works the spanner round the rim until the salt lets go in white flakes and the hatch turns.",
      seconds: 15,
    },
    {
      id: "stow-case",
      verbs: ["stow", "put", "load", "place", "set", "secure"],
      targetId: "sample-case",
      requires: [
        { kind: "carrying", thingId: "sample-case", unmet: "He is not carrying the case." },
        { kind: "state", thingId: "bell-hatch", stateId: "free", unmet: "The bell hatch is still salt-seized." },
      ],
      effects: [
        { kind: "set-state", thingId: "sample-case", stateId: "aboard" },
        { kind: "drop", thingId: "sample-case" },
      ],
      shot: "A pressure case pushed up through an open bell hatch and wedged against the inner wall with a folded jacket.",
      tell: "The case goes up through the hatch and wedges against the inner wall.",
      seconds: 15,
    },
    {
      id: "blow-ballast",
      verbs: ["pull", "blow", "release", "drop", "throw", "let go"],
      targetId: "ballast",
      requires: [
        { kind: "state", thingId: "sample-case", stateId: "aboard", unmet: "Nothing is aboard the bell yet." },
        { kind: "state", thingId: "ballast", stateId: "set", unmet: "The weights are already gone." },
      ],
      effects: [{ kind: "set-state", thingId: "ballast", stateId: "blown" }],
      shot: "A red lever hauled down inside a bell collar; weights let go with a clang and the whole bell lifts hard out of frame trailing bubbles.",
      tell: "The weights go with a sound like a church, and the bell leaves the collar faster than anything that heavy should.",
      seconds: 15,
    },
    {
      id: "check-gas-rack",
      verbs: ["check", "read", "look at", "examine", "turn", "inspect"],
      targetId: "gas-rack",
      requires: [{ kind: "state", thingId: "gas-rack", stateId: "unchecked", unmet: "He has already read the gauges." }],
      effects: [{ kind: "set-state", thingId: "gas-rack", stateId: "checked" }],
      shot: "A hand turns a strapped gas bottle in its rack to bring the contents gauge round to the light; the needle sits a long way left of where it should.",
      tell: "He turns the bottles to read them. Every needle is further left than the log says it should be.",
      seconds: 15,
    },
  ],
  goal: {
    description: "Send the core sample up in the ascent bell.",
    requires: [
      { kind: "state", thingId: "sample-case", stateId: "aboard", unmet: "The sample is not aboard the bell." },
      { kind: "state", thingId: "ballast", stateId: "blown", unmet: "The bell is still in its collar." },
      { kind: "at", locationId: "bell-trunk", unmet: "He is not at the bell trunk." },
    ],
    tell: "He holds the rungs while the trunk fills with noise, and eleven days of seabed goes up towards a surface he has not seen in a fortnight.",
  },
} as const;
