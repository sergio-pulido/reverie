import { focusOn, press, render, settle, type Entry } from "./render";
import assert from "node:assert/strict";
import { act } from "react";
import { App } from "../src/App";
import { CONSTRAINT_IDS, nextTurnId } from "../src/catalogue/refinements";
import type { RankResponse, TurnResponse } from "../src/conversation/contract";
import { AssistantProvider, type Assistant } from "../src/discover/AssistantContext";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import type { Constraint, Evidence } from "../src/preferences/schema";
import { fakeCatalogue } from "./catalogueFake";

/**
 * The search screen through the whole app, over a test catalogue and a test assistant. The
 * assistant reads a few words the way the model would and states them as grounded evidence; the
 * browser's engine then judges its turns exactly as it judges the model's.
 */

type Heard = { dimensions: [string, Omit<Evidence, "sourceTurnId">][]; constraints: Omit<Constraint, "sourceTurnId">[] };

function interpret(message: string): Heard {
  const heard: Heard = { dimensions: [], constraints: [] };
  const lower = message.toLowerCase();
  if (lower.includes("funny")) heard.dimensions.push(["genre.comedy", { value: 1, confidence: 0.9, quote: "funny", explicit: true }]);
  if (lower.includes("scary")) heard.dimensions.push(["genre.horror", { value: 1, confidence: 0.9, quote: "scary", explicit: true }]);
  if (lower.includes("nineties")) {
    heard.constraints.push(
      { id: CONSTRAINT_IDS.yearMin, predicate: { kind: "number", field: "year", operator: "gte", value: 1990 }, quote: "nineties" },
      { id: CONSTRAINT_IDS.yearMax, predicate: { kind: "number", field: "year", operator: "lte", value: 1999 }, quote: "nineties" },
    );
  }
  return heard;
}

/** Rankings wait on this while it is held, so a turn stays waiting for its films. */
export function rankingGate() {
  let open: () => void = () => undefined;
  let held = new Promise<void>((resolve) => (open = resolve));
  return {
    wait: () => held,
    release: () => open(),
    hold: () => {
      held = new Promise<void>((resolve) => (open = resolve));
    },
  };
}

export function fakeAssistant(gate?: ReturnType<typeof rankingGate>) {
  const turns: string[] = [];
  const rankings: string[][] = [];
  const client: Assistant = {
    async requestTurn(message, state): Promise<TurnResponse> {
      turns.push(message);
      const turnId = nextTurnId(state);
      const heard = interpret(message);
      const stated = heard.dimensions.length > 0 || heard.constraints.length > 0;
      return {
        status: "ok",
        source: "nebius",
        model: "test",
        turn: {
          sessionId: state.sessionId,
          turnId,
          expectedStateVersion: state.stateVersion,
          transcript: message,
          dimensions: Object.fromEntries(heard.dimensions.map(([name, evidence]) => [name, { ...evidence, sourceTurnId: turnId }])),
          setConstraints: heard.constraints.map((constraint) => ({ ...constraint, sourceTurnId: turnId })),
          removeConstraints: [],
        },
        acknowledgement: stated ? `Heard: ${message}.` : "Tell me a little more.",
        question: stated ? null : "Something funny, or something tense?",
      };
    },
    async requestRanking(state, titles): Promise<RankResponse> {
      rankings.push(titles.map(({ id }) => id));
      await gate?.wait();
      // The assistant's order is the catalogue's, reversed, so its hand is visible.
      const ranking = [...titles].reverse().map(({ id }, index) => ({ candidateId: id, utility: 1 - index / 100 }));
      return { status: "ok", source: "nebius", model: "test", stateVersion: state.stateVersion, ranking, reasons: [{ candidateId: ranking[0].candidateId, reason: "The best fit here." }] };
    },
  };
  return { client, turns, rankings };
}

export async function openSearch(at: string | Entry[] = "/discover", { unknown = [] as readonly string[], gate }: { unknown?: readonly string[]; gate?: ReturnType<typeof rankingGate> } = {}) {
  const catalogue = fakeCatalogue({ unknown });
  const assistant = fakeAssistant(gate);
  await render(
    <CatalogueReadProvider read={catalogue.read}>
      <AssistantProvider assistant={assistant.client}>
        <App />
      </AssistantProvider>
    </CatalogueReadProvider>,
    at,
  );
  return { catalogue, assistant };
}

export const field = () => {
  const input = document.querySelector<HTMLInputElement>('.search-field input[type="search"]');
  assert.ok(input, "the search field is on screen");
  return input;
};

/** Types into a field the way a keyboard does, so React sees the change. */
export async function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle(1);
}

/** Types a message into the field and sends it with OK, as a viewer would. */
export async function say(text: string) {
  await focusOn(field());
  await type(field(), text);
  await press("Enter");
  await settle(6);
}

/** Each turn as the screen shows it: what was said, and the titles of its posters. */
export function turns() {
  return Array.from(document.querySelectorAll(".search-turn")).map((turn) => ({
    lines: Array.from(turn.querySelectorAll(".search-line")).map((line) => line.textContent?.replace(/^(You said|Assistant|Notice): /, "")),
    posters: Array.from(turn.querySelectorAll(".search-card-title")).map((title) => title.textContent),
    caption: turn.querySelector(".search-results-caption")?.textContent ?? null,
  }));
}

export const cards = (turn: number) => Array.from(document.querySelectorAll(".search-turn")[turn]?.querySelectorAll<HTMLButtonElement>(".search-card") ?? []);
