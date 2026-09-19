import { FormEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { providerIdOf, type CatalogueTitle } from "./catalogue/contract";
import type { Jam as GeneratedJam, JamSource } from "./core/jam";
import { DiscoverScreen } from "./discover/DiscoverScreen";
import { FilmPage } from "./discover/FilmPage";
import { TMDB_ATTRIBUTION_FALLBACK } from "./discover/TmdbAttribution";
import { HomeScreen } from "./home/HomeScreen";
import {
  DEFAULT_PORTION_MAX_SECONDS,
  DEFAULT_PORTION_MIN_SECONDS,
  DEFAULT_TOTAL_SECONDS,
} from "./core/script";
import { safeMessageOf } from "./lib/errors";
import { createJam as createJamRoom, type JamPersistence, type JamRoom, type JamVisibility } from "./lib/jams";
import {
  DESTINATION_PATH,
  DISCOVER_PATH,
  JAMS_PATH,
  JOIN_PATH,
  NEW_JAM_PATH,
  filmFromPath,
  filmPath,
  jamSlugFromPath,
  screenFromPath,
  type Destination,
  type Screen,
} from "./lib/routes";
import { hasSupabaseConfiguration } from "./lib/supabase";
import { ScriptScreen } from "./ScriptScreen";
import { CreateRoom, type SourceKind } from "./screens/CreateRoom";
import { JamRegistry } from "./screens/JamRegistry";
import { JoinRoom } from "./screens/JoinRoom";
import { PreviewStudio } from "./screens/PreviewStudio";
import { Studio } from "./screens/Studio";
import { behindIntact, entryFrom, keyCurrentEntry, pushedEntry, replacingEntry } from "./shell/history";
import { leaveAction } from "./shell/keys";
import { ShellProvider, type Shell } from "./shell/ShellContext";
import { focusIsLost, focusTopBar } from "./shell/topBarFocus";
import { useRemoteConventions } from "./shell/useRemoteConventions";

/** Loaded only if the app itself renders `/`; a production build serves `/` as static HTML. */
const LandingRoute = lazy(() => import("./landing/LandingRoute"));

/** Screens with no rows of their own to land in: a remote arrives on their top bar. */
const LANDS_ON_TOP_BAR: ReadonlySet<Screen> = new Set(["jams", "create", "join", "script", "studio"]);

function inviteCodeFromLocation() {
  return new URLSearchParams(window.location.search).get("code") ?? "";
}

/** A request, made by the top bar's search icon, for Discover to focus its field. */
export type SearchRequest = { id: number };

let searchRequests = 0;

type Location = { screen: Screen; slug: string | null; film: ReturnType<typeof filmFromPath>; from: string | null; inviteCode: string };

function readLocation(): Location {
  const { pathname } = window.location;
  return { screen: screenFromPath(pathname), slug: jamSlugFromPath(pathname), film: filmFromPath(pathname), from: entryFrom(), inviteCode: inviteCodeFromLocation() };
}

export function App() {
  const [location, setLocation] = useState<Location>(readLocation);
  const { screen, slug, film, from, inviteCode } = location;
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  /** A search asked for from a film page, carried across the history step that closes it. */
  const pendingSearch = useRef<SearchRequest | null>(null);
  /** The home's copy of the film it opened, shown while the full record loads, and only for that film. */
  const [filmSeed, setFilmSeed] = useState<{ providerId: string; title: CatalogueTitle } | null>(null);
  const [roomTitle, setRoomTitle] = useState("Untitled Movie Jam");
  const [premise, setPremise] = useState("A signal changes what the room thinks is possible.");
  const [visibility, setVisibility] = useState<JamVisibility>("invite_only");
  const [persistence, setPersistence] = useState<JamPersistence>(hasSupabaseConfiguration() ? "remote" : "preview");
  const [sourceKind, setSourceKind] = useState<SourceKind>("from-scratch");
  const [importedScript, setImportedScript] = useState("");
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
    setLocation({ screen: next, slug: jamSlugFromPath(path), film: filmFromPath(path), from: entryFrom(state), inviteCode: inviteCodeFromLocation() });
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

  /** A screen with nothing of its own to focus lands on its top bar, so a remote is never lost. */
  useEffect(() => {
    if (LANDS_ON_TOP_BAR.has(screen) && focusIsLost()) focusTopBar({ scroll: false });
  }, [screen, slug]);

  const filmOpen = screen === "discover" && film !== null;
  /** A film opened from the home (at whatever path it was served) is a layer over the home. */
  const filmOrigin: Destination = filmOpen && from !== null && screenFromPath(from) === "home" ? "home" : "discover";

  /** Back from the top bar. Answers false on the home, whose Back belongs to the platform. */
  function leave() {
    const action = leaveAction({ screen, filmOpen, from, behindIntact: behindIntact() });
    if (!action) return false;
    if (action.kind === "history-back") window.history.back();
    else navigate(screenFromPath(action.path), action.path, { replace: true });
    return true;
  }
  useRemoteConventions(leave);

  /** A film page closes to where it was opened from, or to the grid when it was reached by URL. */
  function closeFilm() {
    leave();
  }

  function startJam() {
    setRegisteredRoom(null);
    setGeneratedJam(null);
    navigate("create", NEW_JAM_PATH);
  }

  function openFilm(title: CatalogueTitle | undefined, providerId: string) {
    setFilmSeed(title ? { providerId, title } : null);
    navigate("discover", filmPath(providerId));
  }

  const shell = useMemo<Shell>(() => ({
    go(destination: Destination) {
      if (filmOpen && destination === filmOrigin) return closeFilm();
      if (!filmOpen && isAt(destination, screen)) {
        window.scrollTo({ top: 0 });
        return;
      }
      navigate(destination === "jam" ? "jams" : destination, DESTINATION_PATH[destination]);
    },
    search() {
      searchRequests += 1;
      const request = { id: searchRequests };
      if (filmOpen && filmOrigin === "discover" && from && behindIntact()) {
        // Close the film the way Back would, and focus the search once the grid is back.
        pendingSearch.current = request;
        window.history.back();
        return;
      }
      // From anywhere else Discover opens fresh; a film page it replaces is not returned to.
      if (screen !== "discover" || filmOpen) navigate("discover", DISCOVER_PATH, { replace: filmOpen });
      setSearchRequest(request);
    },
  }), [screen, filmOpen, filmOrigin, from]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const roomPremise = sourceKind === "from-scratch" ? premise.trim() : "A Movie Jam created from an imported script.";
    setIsCreating(true);
    setNotice(null);
    try {
      const created = registeredRoom
        ? { jam: registeredRoom, persistence }
        : await createJamRoom({ id: crypto.randomUUID(), title: roomTitle.trim(), premise: roomPremise.slice(0, 280), visibility });
      setRegisteredRoom(created.jam);
      applyJam(created.jam, created.persistence);
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
        setNotice(`Jam registered, but its script is not ready: ${body?.error?.safeMessage ?? "the script could not be created."}`);
        return;
      }
      const script = body.jam as GeneratedJam;
      setGeneratedJam(script);
      navigate("script", `/jams/${created.jam.slug}`);
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
          onStartJam={startJam}
          onJoin={() => navigate("join", JOIN_PATH)}
        />
      </>;
    }
    if (screen === "discover") {
      return <DiscoverScreen
        film={film}
        searchRequest={searchRequest}
        onOpenFilm={(providerId) => openFilm(undefined, providerId)}
        onCloseFilm={closeFilm}
      />;
    }
    if (screen === "jams") return <JamRegistry onNew={startJam} onOpen={(jam, mode) => { applyJam(jam, mode); navigate("studio", `/jams/${jam.slug}`); }} />;
    if (screen === "create") {
      return <CreateRoom title={roomTitle} premise={premise} visibility={visibility} sourceKind={sourceKind} importedScript={importedScript} totalSeconds={totalSeconds} portionMinSeconds={portionMinSeconds} portionMaxSeconds={portionMaxSeconds} onTitle={setRoomTitle} onPremise={setPremise} onVisibility={setVisibility} onSourceKind={setSourceKind} onImportedScript={setImportedScript} onTotalSeconds={setTotalSeconds} onPortionMinSeconds={setPortionMinSeconds} onPortionMaxSeconds={setPortionMaxSeconds} onSubmit={createRoom} isCreating={isCreating} notice={notice} />;
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
  return screen === "jams";
}
