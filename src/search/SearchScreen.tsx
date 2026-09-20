import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { providerIdOf, type CatalogueTitle } from "../catalogue/contract";
import type { Critique } from "../conversation/contract";
import type { SearchRequest } from "../App";
import { FilmPage } from "../discover/FilmPage";
import { TMDB_ATTRIBUTION_FALLBACK, TmdbAttribution } from "../discover/TmdbAttribution";
import type { FilmRoute } from "../lib/routes";
import { TopBar } from "../shell/TopBar";
import { focusIsLost, focusTopBar } from "../shell/topBarFocus";
import { useVoiceInput } from "../voice/useVoiceInput";
import { mergeIntoDraft } from "../voice/voiceState";
import { Composer, COMPOSER_ROW } from "./Composer";
import { carriesRequest } from "./filler";
import { FilmPreview } from "./FilmPreview";
import { FilterPanel } from "./FilterPanel";
import { NarrowingStrip, STRIP_ROW, stripCells } from "./NarrowingStrip";
import { PendingVoice } from "./PendingVoice";
import { turnsOf } from "./results";
import { SearchTranscript, turnRow } from "./SearchTranscript";
import { TurnFilms } from "./TurnFilms";
import { useHoverPreview } from "./useHoverPreview";
import { useNarrow } from "./useNarrow";
import { useRows, type Row } from "../shell/useRows";
import { useSearch } from "./useSearch";
import { useViewport } from "./useViewport";
import { useVoicePreview } from "./useVoicePreview";

type SearchScreenProps = {
  /** The film the URL names, drawn as a layer over the conversation; null for none. */
  film: FilmRoute;
  /** Set when the top bar asked for the field. */
  searchRequest: SearchRequest | null;
  onOpenFilm: (providerId: string) => void;
  onCloseFilm: () => void;
  onStartJam: (title: CatalogueTitle) => void;
};

export const INVITATION = "What do you feel like watching?";
const NOT_A_REQUEST = "Say a little more: a film’s name, a genre, a mood.";

/**
 * What the field invites, in three states. A phone's field is a third of a television's, and a
 * sentence that reads well across a room is cut mid-word there, so it has its own shorter words
 * rather than the same ones trimmed by the browser.
 */
const PLACEHOLDERS = {
  wide: { resting: "Name a film, or say what you’re in the mood for…", answering: "Answer, or ask for something else…", narrowing: "Narrow it down, or ask for something else…" },
  phone: { resting: "A film, or a mood…", answering: "Answer, or ask again…", narrowing: "Narrow it down…" },
} as const;

/**
 * Finding something to watch, as a conversation. It opens on one line, the field and the
 * microphone, and no films: nothing is shown until the viewer has asked for something. Each
 * message then becomes a block: what was said, what came back, and the films that answer it.
 * A refinement adds a block rather than rewriting the page, so scrolling back shows how the
 * search narrowed.
 *
 * The field takes a film's name or a request in the viewer's own words; speaking fills a pending
 * line in the conversation as it is heard, and the final transcript waits in the field to be
 * sent. Filters live in their own panel. A film opens as a preview over the conversation, and
 * from there its page or a new Jam.
 */
export function SearchScreen({ film, searchRequest, onOpenFilm, onCloseFilm, onStartJam }: SearchScreenProps) {
  const search = useSearch();
  const narrow = useNarrow();
  useViewport();
  const { refinement, conversation, pending, waiting } = search;
  const [draft, setDraft] = useState("");
  /** The draft came from speech and has not been sent: the pending line stays up, showing it. */
  const [spokenDraft, setSpokenDraft] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [preview, setPreview] = useState<{ title: CatalogueTitle; opener: HTMLElement; critique: Critique | null } | null>(null);
  const [filmSeed, setFilmSeed] = useState<CatalogueTitle | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const voiceRef = useRef<HTMLButtonElement | null>(null);
  const filtersRef = useRef<HTMLButtonElement | null>(null);
  /** Where focus goes back to once the layer over it (a preview, the panel, a film) closes. */
  const restore = useRef<HTMLElement | null>(null);

  const filmOpen = film !== null;
  const layered = filmOpen || preview !== null || filtersOpen;
  const started = conversation.lines.length > 0;
  const answering = conversation.openQuestion !== null;

  const focusInput = useCallback(() => inputRef.current?.focus({ preventScroll: true }), []);

  const voice = useVoiceInput({
    onTranscript(text) {
      if (!carriesRequest(text, { answering })) {
        setHint(NOT_A_REQUEST);
        return;
      }
      setDraft((current) => mergeIntoDraft(current, text));
      setSpokenDraft(true);
      setHint(null);
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      // The caret goes after the transcript, ready for OK or a correction.
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
    },
  });
  const speaking = voice.phase !== "idle";
  const pendingShown = speaking || (spokenDraft && draft.trim().length > 0);
  const heard = useVoicePreview(speaking ? voice.partial : draft, search.filters, pendingShown);

  const { hover, dwell } = useHoverPreview((title, card, critique) => openPreview(title, card, critique));

  const openPreview = useCallback(
    (title: CatalogueTitle, card: HTMLElement, critique: Critique | null = null) => {
      dwell.opened(card);
      setPreview({ title, opener: card, critique });
    },
    [dwell],
  );

  const closePreview = useCallback(() => {
    restore.current = preview?.opener ?? null;
    setPreview(null);
    dwell.closed();
  }, [preview, dwell]);

  function openFilmPage(title: CatalogueTitle) {
    restore.current = preview?.opener ?? null;
    setFilmSeed(title);
    setPreview(null);
    dwell.closed();
    onOpenFilm(providerIdOf(title.id));
  }

  function closeFilters() {
    restore.current = filtersRef.current;
    setFiltersOpen(false);
  }

  function send() {
    const verdict = search.check(draft);
    if (verdict === "filler") setHint(NOT_A_REQUEST);
    if (verdict !== "sent") return;
    const message = draft;
    setDraft("");
    setSpokenDraft(false);
    setHint(null);
    void search.send(message);
  }

  function startOver() {
    restore.current = inputRef.current;
    setDraft("");
    setSpokenDraft(false);
    setHint(null);
    refinement.reset();
  }

  /** "Not this one" on a film page: it leaves every answer from now on. */
  function rejectFilm(id: string) {
    refinement.reject(id);
    onCloseFilm();
  }

  /**
   * When a layer closes, focus goes back to what opened it, once it can take focus again. With
   * nothing to go back to (the page just opened, or its film page was reached by URL), a remote
   * pressing into nothing would be lost, so the field takes it.
   */
  const wasLayered = useRef<boolean | null>(null);
  useEffect(() => {
    const uncovered = wasLayered.current !== false && !layered;
    wasLayered.current = layered;
    const target = restore.current;
    if (!target) {
      if (uncovered && focusIsLost()) focusInput();
      return;
    }
    // Still under a layer (a preview closed over the open filter panel's page): wait for it.
    if (target.closest("[inert]")) return;
    restore.current = null;
    if (target.isConnected) target.focus({ preventScroll: true });
    else focusInput();
  });

  /** The top bar's Search lands in the field, at the newest end of the conversation. */
  const handledSearch = useRef<number | null>(null);
  useEffect(() => {
    if (!searchRequest || layered || handledSearch.current === searchRequest.id) return;
    handledSearch.current = searchRequest.id;
    restore.current = null;
    window.scrollTo({ top: document.documentElement.scrollHeight });
    focusInput();
  }, [searchRequest, layered, focusInput]);

  const blocks = useMemo(() => turnsOf(conversation.lines), [conversation.lines]);
  const waitingLines = useMemo(() => new Set(waiting.map(({ lineId }) => lineId)), [waiting]);
  const rows = useMemo<Row[]>(
    () => [
      ...blocks.flatMap((block) => (block.answer && block.answer.results.titles.length > 0 ? [{ key: turnRow(block.turn), count: block.answer.results.titles.length }] : [])),
      ...(started ? [{ key: STRIP_ROW, count: stripCells(refinement.state) }] : []),
      { key: COMPOSER_ROW, count: 3 },
    ],
    [blocks, started, refinement.state],
  );
  const enterRow = useCallback((row: string) => {
    if (row !== COMPOSER_ROW) return false;
    focusInput();
    return true;
  }, [focusInput]);
  const exitTop = useCallback(() => {
    focusTopBar();
  }, []);
  const nav = useRows(rows, { onExitTop: exitTop, enter: enterRow });

  /** New lines and new films appear at the bottom; follow them while the viewer is at the field. */
  const last = blocks.at(-1);
  const growth = `${conversation.lines.length}:${last?.answer ? 1 : 0}:${waiting.length}:${pendingShown}:${heard.titles?.length ?? 0}`;
  useEffect(() => {
    if (!started && !pendingShown) return;
    const active = document.activeElement;
    if (focusIsLost(active) || (active instanceof HTMLElement && active.closest(".search-dock"))) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [growth]); // eslint-disable-line react-hooks/exhaustive-deps

  const filmsOnScreen = blocks.some((block) => (block.answer?.results.titles.length ?? 0) > 0) || (pendingShown && (heard.titles?.length ?? 0) > 0);
  const openFilmId = film && "id" in film ? film.id : null;
  const invitations = PLACEHOLDERS[narrow ? "phone" : "wide"];
  const placeholder = !started ? invitations.resting : answering ? invitations.answering : invitations.narrowing;

  return (
    <>
      {film && (
        <FilmPage
          providerId={openFilmId}
          seed={filmSeed && openFilmId && providerIdOf(filmSeed.id) === openFilmId ? filmSeed : undefined}
          origin="discover"
          attributionFallback={TMDB_ATTRIBUTION_FALLBACK}
          onReject={rejectFilm}
        />
      )}
      <main
        ref={nav.containerRef}
        className={`search-shell ${started ? "search-shell-talking" : "search-shell-resting"}${filmsOnScreen ? " search-shell-films" : ""}`}
        inert={layered}
        onKeyDown={nav.onKeyDown}
        onFocus={nav.onFocus}
      >
        <TopBar current="discover" onEnterPage={focusInput} />
        <div className="search-stage">
          {!started && <h1 className="search-invitation">{INVITATION}</h1>}
          {(started || pendingShown) && (
            <SearchTranscript blocks={blocks} waiting={waitingLines} pending={pending} cellProps={nav.cellProps} onOpen={openPreview} hover={hover}>
              {pendingShown && <PendingVoice phase={voice.phase} level={voice.level} text={speaking ? voice.partial : draft} detected={heard.detected} titles={heard.titles} />}
            </SearchTranscript>
          )}
          <div className="search-dock">
            {started && (
              <NarrowingStrip
                state={refinement.state}
                count={search.live?.total ?? null}
                notice={refinement.notice}
                filtersRef={filtersRef}
                cellProps={nav.cellProps}
                onOpenFilters={() => {
                  dwell.cancel();
                  setFiltersOpen(true);
                }}
                onWithdraw={refinement.withdraw}
                onRestore={refinement.restore}
                onReset={startOver}
              />
            )}
            <Composer
              draft={draft}
              onDraft={(value) => {
                setDraft(value);
                if (!value.trim()) setSpokenDraft(false);
                setHint(null);
              }}
              onSend={send}
              pending={pending}
              placeholder={placeholder}
              voice={voice}
              inputRef={inputRef}
              voiceRef={voiceRef}
              status={hint ?? voice.notice}
            />
          </div>
        </div>
        {filmsOnScreen && <TmdbAttribution />}
        {waiting.map((turn) => (
          <TurnFilms key={turn.lineId} turn={turn} shared={search.shared} onSettled={search.settle} />
        ))}
      </main>

      {filtersOpen && (
        <div className="search-layer" inert={preview !== null || filmOpen}>
          <FilterPanel
            state={refinement.state}
            refined={search.filters !== null}
            live={search.live}
            failure={search.liveFailure}
            notice={refinement.notice}
            attribution={TMDB_ATTRIBUTION_FALLBACK}
            onChoose={refinement.choose}
            onUnchoose={refinement.unchoose}
            onClose={closeFilters}
            onOpen={openPreview}
            hover={hover}
          />
        </div>
      )}
      {preview && !filmOpen && (
        <FilmPreview
          title={preview.title}
          critique={preview.critique}
          attribution={TMDB_ATTRIBUTION_FALLBACK}
          sheet={narrow}
          onClose={closePreview}
          onOpenFilm={openFilmPage}
          onStartJam={onStartJam}
        />
      )}
    </>
  );
}

