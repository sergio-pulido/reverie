import { useCallback, useEffect, useState } from "react";
import { isConsentEffective, type LiveConsent } from "../core/liveMedia";
import { safeMessageOf } from "../lib/errors";
import { loadLiveConsents, subscribeToLiveConsents } from "../lib/liveMedia";

/**
 * The room's live-consent register, held once.
 *
 * Every panel that shows or acts on consent reads this one copy, so the stage and the film
 * can never disagree about what somebody agreed to. It is one subscription to one table,
 * which also keeps two channels of the same name from racing each other.
 *
 * Expiry is a deadline, not an event: a grant that lapses produces no row change, so the
 * hook re-evaluates exactly when the next one passes rather than polling.
 */
export function useConsentRegister(jamId: string | null, canRead: boolean) {
  const [consents, setConsents] = useState<readonly LiveConsent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!jamId || !canRead) return;
    let active = true;

    void loadLiveConsents(jamId)
      .then((rows) => { if (active) { setConsents(rows); setError(null); } })
      .catch((cause: unknown) => {
        if (active) setError(safeMessageOf(cause, "The consent register could not be loaded."));
      });

    const stop = subscribeToLiveConsents(jamId, (consent) => {
      if (!active) return;
      setConsents((current) => merge(current, consent));
    });

    return () => { active = false; stop(); };
  }, [jamId, canRead, tick]);

  // Re-render when the soonest standing grant lapses, so nothing claims to still stand.
  useEffect(() => {
    const now = Date.now();
    const delays = consents
      .filter((consent) => isConsentEffective(consent, now))
      .map((consent) => Date.parse(consent.expires_at) - now)
      .filter((delay) => Number.isFinite(delay) && delay > 0);
    if (delays.length === 0) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.min(...delays) + 250);
    return () => clearTimeout(timer);
  }, [consents, tick]);

  /** Stamps a row locally so a withdrawal stops here at once, not when Realtime catches up. */
  const markWithdrawn = useCallback((consentId: string) => {
    setConsents((current) =>
      current.map((consent) =>
        consent.id === consentId ? { ...consent, withdrawn_at: new Date().toISOString() } : consent,
      ),
    );
  }, []);

  const add = useCallback((consent: LiveConsent) => {
    setConsents((current) => merge(current, consent));
  }, []);

  return { consents, error, reload, add, markWithdrawn };
}

function merge(current: readonly LiveConsent[], incoming: LiveConsent): LiveConsent[] {
  const others = current.filter((consent) => consent.id !== incoming.id);
  return [...others, incoming].sort((a, b) =>
    a.granted_at === b.granted_at ? a.id.localeCompare(b.id) : a.granted_at < b.granted_at ? -1 : 1,
  );
}
