import { scenarioSchema, type Scenario } from "../scenario";
import { coldSill } from "./coldSill";
import { nightAudit } from "./nightAudit";
import { theUnderstudy } from "./theUnderstudy";

/**
 * The scenarios this build ships, parsed once at module load.
 *
 * Parsing here rather than at use is deliberate: a scenario that names a
 * state it does not have is a bug in this repository's own data, and it
 * should stop the process that loads it rather than surface as a room whose
 * key silently never fits.
 */
export const SCENARIOS: readonly Scenario[] = [nightAudit, coldSill, theUnderstudy].map(
  (scenario) => scenarioSchema.parse(scenario),
);

export function findScenario(id: string): Scenario | null {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

/** What the create screen lists: enough to choose, not the whole world. */
export interface ScenarioCard {
  readonly id: string;
  readonly title: string;
  readonly logline: string;
  readonly characterName: string;
  readonly goal: string;
  readonly locationCount: number;
}

export function scenarioCards(): readonly ScenarioCard[] {
  return SCENARIOS.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    logline: scenario.logline,
    characterName: scenario.character.name,
    goal: scenario.goal.description,
    locationCount: scenario.locations.length,
  }));
}
