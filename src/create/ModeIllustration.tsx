/** Decorative diagrams of the activity, never presented as generated film output. */
export function ModeIllustration({ mode }: { mode: "director" | "jam" | "escape" | "exam" }) {
  return <svg className={`mode-illustration mode-${mode}`} viewBox="0 0 320 180" fill="none" aria-hidden="true" focusable="false">
    {mode === "director" && <><rect x="42" y="24" width="236" height="130" rx="8" /><path d="M42 54h236M72 24l24 30m24-30 24 30m24-30 24 30m24-30 24 30" /><path d="m143 78 42 24-42 24z" /></>}
    {mode === "jam" && <><rect x="109" y="52" width="102" height="76" rx="8" /><path d="M129 77h62m-62 18h45m-45 18h54M74 48l35 24m102 0 35-24M74 142l35-24m102 0 35 24" /><circle cx="60" cy="38" r="18" /><circle cx="260" cy="38" r="18" /><circle cx="60" cy="152" r="18" /><circle cx="260" cy="152" r="18" /></>}
    {mode === "escape" && <><path d="M48 150V30h96v48h48V30h80v120H144v-36H96v36zM48 78h48m96 36h40V78h40" /><circle cx="70" cy="126" r="7" /><path d="M242 150v-24m-10 10 10-10 10 10" /></>}
    {mode === "exam" && <><rect x="91" y="24" width="138" height="140" rx="8" /><path d="M135 24v-8h50v8M135 65h65m-65 35h65m-65 35h65m-83-76 7 7 12-14m-19 42 7 7 12-14" /><circle cx="120" cy="135" r="6" /></>}
  </svg>;
}
