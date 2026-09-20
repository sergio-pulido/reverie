import { randomPremise } from "./create/premises";
import { FormEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AboutScreen } from "./about/AboutScreen";
import { CatalogScreen } from "./catalog/CatalogScreen";
import { CreateScreen, type CreateWay } from "./create/CreateScreen";
import { providerIdOf, type CatalogueTitle } from "./catalogue/contract";
import type { Jam as GeneratedJam, JamSource } from "./core/jam";
import { FilmPage } from "./discover/FilmPage";
import { TMDB_ATTRIBUTION_FALLBACK } from "./discover/TmdbAttribution";
import { HomeScreen } from "./home/HomeScreen";
import {
  DEFAULT_PORTION_MAX_SECONDS,
  DEFAULT_PORTION_MIN_SECONDS,
  DEFAULT_TOTAL_SECONDS,
} from "./core/script";
import { openEscapeRoom, readScenarios, type ScenarioCard } from "./lib/escapeRoom";
import { safeMessageOf } from "./lib/errors";
import { createJam as createJamRoom, type JamPersistence, type JamRoom, type JamVisibility } from "./lib/jams";
import { rememberStartedKind } from "./lib/startedKinds";
import {
  ABOUT_PATH,
  CREATE_PATH,
  DESTINATION_PATH,
  redirectFor,
  JAMS_PATH,
  LANDING_PATH,
  DISCOVER_PATH,
  JOIN_PATH,
  NEW_JAM_PATH,
  createPath,
  createWayFromPath,
  destinationOf,

  directorPath,
  directorSlugFromPath,
  filmFromPath,
  filmPath,
  jamSlugFromPath,
  screenFromPath,
  type Destination,
  type Screen,
} from "./lib/routes";
import { hasSupabaseConfiguration } from "./lib/supabase";
import { useViewerSource } from "./shell/ViewerContext";
import { ScriptScreen } from "./ScriptScreen";
import { CreateRoom, type SourceKind } from "./screens/CreateRoom";
import { DirectorScreen } from "./director/DirectorScreen";
import { JamRegistry } from "./screens/JamRegistry";
import { JoinRoom } from "./screens/JoinRoom";
import { PreviewStudio } from "./screens/PreviewStudio";
import { jamSeedFrom } from "./search/jamSeed";
import { SearchScreen } from "./search/SearchScreen";
import { Studio } from "./screens/Studio";
import { behindIntact, entryFrom, keyCurrentEntry, pushedEntry, replacingEntry } from "./shell/history";
import { leaveAction } from "./shell/keys";
import { ShellProvider, type Shell } from "./shell/ShellContext";
import { focusIsLost, focusTopBar } from "./shell/topBarFocus";
import { useRemoteConventions } from "./shell/useRemoteConventions";

/** Loaded only if the app itself renders `/`; a production build serves `/` as static HTML. */
const LandingRoute = lazy(() => import("./landing/LandingRoute"));

/** Screens with no rows of their own to land in: a remote arrives on their top bar. */
const LANDS_ON_TOP_BAR: ReadonlySet<Screen> = new Set(["about", "catalog", "jams", "create", "newJam", "join", "script", "studio", "director"]);

/**
 * Screens a film page is drawn as a layer over rather than in place of, so they keep their scroll,
 * what they have loaded and their focus target while the page is open. Every other film page
 * belongs to Discover, which is also where one reached by URL lands.
 */
const FILM_LAYER_OVER: ReadonlySet<Screen> = new Set(["home", "catalog"]);

function inviteCodeFromLocation() {
  return new URLSearchParams(window.location.search).get("code") ?? "";
}

/** A request, made by the top bar's Search, for the search screen to focus its field. */
export type SearchRequest = { id: number };

let searchRequests = 0;

type Location = { screen: Screen; slug: string | null; film: ReturnType<typeof filmFromPath>; from: string | null; inviteCode: string };

/** The jam a path names, whether it is the room's or its Director session's. */
function slugOf(pathname: string) {
  return jamSlugFromPath(pathname) ?? directorSlugFromPath(pathname);
}

/**
 * Where the viewer is.
 *
 * A path that no longer names a screen is corrected first, in place, so a link someone already
 * shared lands somewhere real and the URL says where that is rather than claiming the old one.
 */
function readLocation(): Location {
  const redirect = redirectFor(window.location.pathname);
  if (redirect) window.history.replaceState(window.history.state, "", redirect);
  const { pathname } = window.location;
  return { screen: screenFromPath(pathname), slug: slugOf(pathname), film: filmFromPath(pathname), from: entryFrom(), inviteCode: inviteCodeFromLocation() };
}

export type AppProps = {
  /** Leaves the authenticated shell for the public document. Injectable for component tests. */
  leaveForLanding?: () => void;
};

function replaceWithLanding() {
  window.location.replace(LANDING_PATH);
}

export function App({ leaveForLanding = replaceWithLanding }: AppProps = {}) {
  const [location, setLocation] = useState<Location>(readLocation);
  const { screen, slug, film, from, inviteCode } = location;
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  /** A search asked for from a film page, carried across the history step that closes it. */
  const pendingSearch = useRef<SearchRequest | null>(null);
  /** The home's copy of the film it opened, shown while the full record loads, and only for that film. */
  const [filmSeed, setFilmSeed] = useState<{ providerId: string; title: CatalogueTitle } | null>(null);
  // The form opens on a titled premise, so a room can be started without typing either.
  const [opening] = useState(() => randomPremise());
  const [roomTitle, setRoomTitle] = useState(opening.title);
  const [premise, setPremise] = useState(opening.premise);
  const [visibility, setVisibility] = useState<JamVisibility>("invite_only");
  const [persistence, setPersistence] = useState<JamPersistence>(hasSupabaseConfiguration() ? "remote" : "preview");
  const [sourceKind, setSourceKind] = useState<SourceKind>("from-scratch");
  /** Which of the three the viewer chose at the door. It decides where a finished jam opens. */
  const [way, setWay] = useState<CreateWay>("jam");
  const [importedScript, setImportedScript] = useState("");
  /** The escape rooms this build ships, read from the server, never invented here. */
  const [scenarios, setScenarios] = useState<readonly ScenarioCard[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [scenariosNotice, setScenariosNotice] = useState<string | null>(null);
  // Seeded from the format defaults rather than repeated here: when the
  // model's limits moved, a second copy of them in this form is what silently
  // started posting jams the server refuses.
  const [totalSeconds, setTotalSeconds] = useState(DEFAULT_TOTAL_SECONDS);
  const [portionMinSeconds, setPortionMinSeconds] = useState(DEFAULT_PORTION_MIN_SECONDS);
  const [portionMaxSeconds, setPortionMaxSeconds] = useState(DEFAULT_PORTION_MAX_SECONDS);
  const [generatedJam, setGeneratedJam] = useState<GeneratedJam | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [registeredRoom, setRegisteredRoom] = useState<JamRoom | null>(null);

  /**
   * Pushes (or replaces) a history entry and shows it. A pushed entry records the entry behind it;
   * a replaced one keeps that record, because what lies behind it has not changed.
   */
  function navigate(next: Screen, path: string, { replace = false }: { replace?: boolean } = {}) {
    const state = replace ? replacingEntry() : pushedEntry();
    if (replace) window.history.replaceState(state, "", path);
    else window.history.pushState(state, "", path);
    setLocation({ screen: next, slug: slugOf(path), film: filmFromPath(path), from: entryFrom(state), inviteCode: inviteCodeFromLocation() });
    setSearchRequest(null);
    setNotice(null);
  }

  useEffect(() => {
    keyCurrentEntry();
    const handlePopState = () => {
      setLocation(readLocation());
      setSearchRequest(pendingSearch.current);
      pendingSearch.current = null;
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  /**
   * The escape rooms are this server's own data, so they are read when they are needed: at the
   * door, which has to say whether there are any, and on the form, which has to offer them.
   */
  useEffect(() => {
    if ((screen !== "create" && screen !== "newJam") || scenarios.length > 0) return;
    let cancelled = false;
    void readScenarios()
      .then((cards) => {
        if (cancelled) return;
        setScenarios(cards);
        setScenarioId((current) => current || (cards[0]?.id ?? ""));
      })
      .catch((error: unknown) => {
        if (!cancelled) setScenariosNotice(safeMessageOf(error, "This server did not list any escape rooms."));
      });
    return () => {
      cancelled = true;
    };
  }, [screen, scenarios.length]);

  /** A screen with nothing of its own to focus lands on its top bar, so a remote is never lost. */
  useEffect(() => {
    if (LANDS_ON_TOP_BAR.has(screen) && focusIsLost()) focusTopBar({ scroll: false });
  }, [screen, slug]);

  const filmOpen = screen === "discover" && film !== null;
  /** Where the open film was chosen (at whatever path that screen was served), or Discover. */
  const openedFrom = filmOpen && from !== null ? screenFromPath(from) : null;
  // Every screen in FILM_LAYER_OVER belongs to a destination, so the fallback is never reached
  // by one of them; it is what a film page opened from anywhere else answers.
  const filmOrigin: Destination = (openedFrom && FILM_LAYER_OVER.has(openedFrom) ? destinationOf(openedFrom) : null) ?? "discover";

  /** Back from the top bar. Answers false on the home, whose Back belongs to the platform. */
  function leave() {
    const action = leaveAction({ screen, filmOpen, from, behindIntact: behindIntact() });
    if (!action) return false;
    if (action.kind === "history-back") window.history.back();
    else navigate(screenFromPath(action.path), action.path, { replace: true });
    return true;
  }
  useRemoteConventions(leave);

  /** A film page closes to where it was opened from, or to search when it was reached by URL. */
  function closeFilm() {
    leave();
  }

  /** The door. Everything that makes something new goes through it. */
  function startSomething() {
    setRegisteredRoom(null);
    setGeneratedJam(null);
    navigate("create", CREATE_PATH);
  }

  /** The form set up for one way: what the door does on a press, and what a refresh recovers. */
  function applyWay(chosen: CreateWay) {
    setWay(chosen);
    setSourceKind(chosen === "escape" ? "escape-room" : "from-scratch");
    // A fresh titled premise each time the door is used, so nobody has to type to start.
    const fresh = randomPremise(premise);
    setRoomTitle(fresh.title);
    setPremise(fresh.premise);
    setRegisteredRoom(null);
    setGeneratedJam(null);
  }

  /** One of the three chosen: the flow it already had, opened at a path that says which. */
  function chooseWay(chosen: CreateWay) {
    applyWay(chosen);
    navigate("newJam", createPath(chosen));
  }

  // The way is the URL's, not the app's memory: a refresh on /create/director must open the
  // Director form, not whatever the app last held. Read whenever the location lands on a form.
  useEffect(() => {
    if (location.screen !== "newJam") return;
    const named = createWayFromPath(window.location.pathname);
    if (named && named !== way) applyWay(named);
    // applyWay reads state it also sets; the location is the only thing this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  function openFilm(title: CatalogueTitle | undefined, providerId: string) {
    setFilmSeed(title ? { providerId, title } : null);
    navigate("discover", filmPath(providerId));
  }

  /**
   * "Start a Jam from this": the Movie Jam form, filled with a title and premise drawn from the
   * film. It does not pass through the door: choosing a film has already said which of the three
   * this is.
   */
  function startJamFrom(title: CatalogueTitle) {
    const seed = jamSeedFrom(title);
    setRoomTitle(seed.title);
    setPremise(seed.premise);
    setWay("jam");
    setSourceKind("from-scratch");
    setRegisteredRoom(null);
    setGeneratedJam(null);
    navigate("newJam", createPath("jam"));
    // Chosen from deep in a conversation: the form opens at its top, not where search was scrolled.
    window.scrollTo({ top: 0 });
  }

  const viewerSource = useViewerSource();

  const shell = useMemo<Shell>(() => {
    function search() {
      searchRequests += 1;
      const request = { id: searchRequests };
      if (filmOpen && filmOrigin === "discover" && from && behindIntact()) {
        // Close the film the way Back would, and focus the field once the conversation is back.
        pendingSearch.current = request;
        window.history.back();
        return;
      }
      // From anywhere else search opens fresh; a film page it replaces is not returned to.
      if (screen !== "discover" || filmOpen) navigate("discover", DISCOVER_PATH, { replace: filmOpen });
      setSearchRequest(request);
    }
    return {
      go(destination: Destination) {
        // Discover is where its field is: choosing it always lands there.
        if (destination === "discover") return search();
        if (filmOpen && destination === filmOrigin) return closeFilm();
        if (!filmOpen && isAt(destination, screen)) {
          window.scrollTo({ top: 0 });
          return;
        }
        navigate(destination === "jam" ? "jams" : destination, DESTINATION_PATH[destination]);
      },
      search,
      /** About is not a destination: it is opened by name, from the footer and the account menu. */
      openAbout() {
        if (screen === "about") {
          window.scrollTo({ top: 0 });
          return;
        }
        navigate("about", ABOUT_PATH);
      },
      /**
       * A real sign-out, then the public landing. `/` is deliberately outside the app's own
       * screens: nothing the signed-out viewer was looking at is carried into it.
       */
      async logOut() {
        await viewerSource.signOut();
        leaveForLanding();
      },
    };
  }, [screen, filmOpen, filmOrigin, from, viewerSource, leaveForLanding]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyJam(jam: JamRoom, mode: JamPersistence) {
    setRoomTitle(jam.title);
    setPremise(jam.premise);
    setVisibility(jam.visibility);
    setPersistence(mode);
  }

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) return;
    const source: JamSource = sourceKind === "from-scratch"
      ? { kind: "from-scratch", prompt: premise.trim() }
      : { kind: "imported-script", scriptTitle: roomTitle.trim() };
    const roomPremise = sourceKind === "from-scratch"
      ? premise.trim()
      : sourceKind === "escape-room"
        ? "A room sharing one character inside an authored escape room."
        : "A Movie Jam created from an imported script.";
    setIsCreating(true);
    setNotice(null);
    try {
      const created = registeredRoom
        ? { jam: registeredRoom, persistence }
        : await createJamRoom({ id: crypto.randomUUID(), title: roomTitle.trim(), premise: roomPremise.slice(0, 280), visibility: way === "director" ? "invite_only" : visibility });
      setRegisteredRoom(created.jam);
      applyJam(created.jam, created.persistence);
      // The jam row does not say which of the three this is, and the routes that would say are
      // the local server's. What was chosen at the door is recorded here, where it is known.
      rememberStartedKind(created.jam.id, way);
      // An escape room has no screenplay to write: the world is authored and
      // the film is whatever the room makes the character do. So it opens the
      // room and goes straight into it, with no script screen in between.
      if (sourceKind === "escape-room") {
        await openEscapeRoom(created.jam.id, scenarioId);
        navigate("studio", `/jams/${created.jam.slug}`);
        return;
      }
      const response = await fetch("/api/jams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: sourceKind === "from-scratch" ? "generate" : "import",
          source,
          ...(sourceKind === "import-script" ? { scriptMarkdown: importedScript.trim() } : {}),
          jamId: created.jam.id,
          format: {
            totalSeconds,
            portionMinSeconds,
            portionMaxSeconds,
          },
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // A deployment that serves only the catalogue and Discover has no
        // studio behind /api/jams at all: say that, rather than blaming the script.
        setNotice(response.status === 404
          ? "The live studio is not attached to this deployment: Director, Movie Jam and Escape Room run on the studio server. Discover and the catalogue work here."
          : `Jam registered, but its script is not ready: ${body?.error?.safeMessage ?? "the script could not be created."}`);
        return;
      }
      const script = body.jam as GeneratedJam;
      setGeneratedJam(script);
      // Alone, the film opens in its Director session; with people, in the script the room shares.
      if (way === "director") navigate("director", directorPath(created.jam.slug));
      else navigate("script", `/jams/${created.jam.slug}`);
      if (created.persistence === "preview") setNotice("Supabase is not configured, so the jam is registered in this browser as a local preview only.");
    } catch (error) {
      setNotice(safeMessageOf(error, "The jam could not be registered."));
    } finally {
      setIsCreating(false);
    }
  }

  function renderScreen() {
    if (screen === "landing") return <Suspense fallback={null}><LandingRoute /></Suspense>;
    const filmOverHome = filmOpen && filmOrigin === "home";
    if (screen === "home" || filmOverHome) {
      // One tree for both, so the home stays mounted (shelves, scroll, focus) under a film.
      return <>
        {filmOverHome && film && <FilmPage
          providerId={"id" in film ? film.id : null}
          seed={filmSeed && "id" in film && filmSeed.providerId === film.id ? filmSeed.title : undefined}
          origin="home"
          attributionFallback={TMDB_ATTRIBUTION_FALLBACK}
        />}
        <HomeScreen
          inert={filmOverHome}
          onOpenFilm={(title) => openFilm(title, providerIdOf(title.id))}
          onStartJam={startSomething}
          onJoin={() => navigate("join", JOIN_PATH)}
          onOpenMade={(made) => navigate("studio", `/jams/${made.slug}`)}
        />
      </>;
    }
    const filmOverCatalog = filmOpen && filmOrigin === "catalog";
    if (screen === "catalog" || filmOverCatalog) {
      // One tree for both, so the catalogue stays mounted (pages, scroll, focus) under a film.
      return <>
        {filmOverCatalog && film && <FilmPage
          providerId={"id" in film ? film.id : null}
          seed={filmSeed && "id" in film && filmSeed.providerId === film.id ? filmSeed.title : undefined}
          origin="catalog"
          attributionFallback={TMDB_ATTRIBUTION_FALLBACK}
        />}
        <CatalogScreen inert={filmOverCatalog} onOpenFilm={(title) => openFilm(title, providerIdOf(title.id))} onOpenMade={(made) => navigate("studio", `/jams/${made.slug}`)} />
      </>;
    }
    if (screen === "discover") {
      return <SearchScreen
        film={film}
        searchRequest={searchRequest}
        onOpenFilm={(providerId) => openFilm(undefined, providerId)}
        onCloseFilm={closeFilm}
        onStartJam={startJamFrom}
      />;
    }
    if (screen === "about") return <AboutScreen />;
    if (screen === "director") return <DirectorScreen slug={slug} />;
    if (screen === "jams") {
      return <JamRegistry
        onNew={startSomething}
        onOpen={(jam, mode) => { applyJam(jam, mode); navigate("studio", `/jams/${jam.slug}`); }}
        onDirect={(jam, mode) => { applyJam(jam, mode); navigate("director", directorPath(jam.slug)); }}
      />;
    }
    if (screen === "create") {
      return <CreateScreen scenarios={scenarios} scenariosNotice={scenariosNotice} onChoose={chooseWay} />;
    }
    if (screen === "newJam") {
      return <CreateRoom way={way} title={roomTitle} premise={premise} visibility={visibility} sourceKind={sourceKind} importedScript={importedScript} scenarios={scenarios} scenarioId={scenarioId} scenariosNotice={scenariosNotice} onScenarioId={setScenarioId} totalSeconds={totalSeconds} portionMinSeconds={portionMinSeconds} portionMaxSeconds={portionMaxSeconds} onTitle={setRoomTitle} onPremise={setPremise} onVisibility={setVisibility} onSourceKind={setSourceKind} onImportedScript={setImportedScript} onTotalSeconds={setTotalSeconds} onPortionMinSeconds={setPortionMinSeconds} onPortionMaxSeconds={setPortionMaxSeconds} onSubmit={createRoom} isCreating={isCreating} notice={notice} />;
    }
    if (screen === "script" && generatedJam) {
      return <ScriptScreen jam={generatedJam} roomTitle={roomTitle} onStudio={() => setLocation((current) => ({ ...current, screen: "studio" }))} />;
    }
    if (screen === "join") {
      return <JoinRoom initialCode={inviteCode} onAdmitted={(result) => navigate("studio", `/jams/${result.slug}`)} />;
    }
    // A build without Supabase can only show the clearly labelled local preview. A configured
    // build that fails reports the failure inside Studio instead.
    return slug && hasSupabaseConfiguration() && !slug.startsWith("preview-")
      ? <Studio slug={slug} onLeave={() => navigate("jams", JAMS_PATH)} />
      : <PreviewStudio slug={slug ?? roomTitle} persistence={persistence} />;
  }

  return <ShellProvider shell={shell}>{renderScreen()}</ShellProvider>;
}

/** Whether choosing `destination` would land where the viewer already is. */
function isAt(destination: Destination, screen: Screen) {
  if (destination === "home") return screen === "home";
  if (destination === "discover") return screen === "discover";
  if (destination === "catalog") return screen === "catalog";
  // The door, not the form beneath it: choosing Create from the form goes back to the door.
  if (destination === "create") return screen === "create";
  return screen === "jams";
}
