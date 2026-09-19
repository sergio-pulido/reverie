// The Vite plugin behind the public landing page at `/`.
//
// It serves `virtual:landing-films`: the real catalogue films the page shows, read once per
// build or dev server by `readLandingFilms`. Where the catalogue cannot be read the page
// renders without its poster rows and the build says why; on Vercel that is an error, because a
// deployed landing must show real films.
//
// After a production build it renders the landing to static HTML and writes it as
// `index.html`, so `/` paints with no JavaScript at all, and moves the app's own shell to
// `app.html`, which every other path is served (see `vercel.json` and `apps/server`).
//
// Only `vite` and Node built-ins are imported here; the repository code it runs is loaded
// through Vite's module runner (`scripts/landing-build.ts`).

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnv, runnerImport, type Plugin, type ResolvedConfig } from "vite";
import type { LandingFilms } from "../src/landing/films.ts";

type LandingBuild = typeof import("./landing-build.ts");

const VIRTUAL_ID = "virtual:landing-films";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** The file the app's shell is written to once `index.html` becomes the landing. */
export const APP_SHELL = "app.html";

const LANDING_ROUTE = /\/src\/landing\/LandingRoute\.tsx$/;
const BUILD_MODULE = "scripts/landing-build.ts";

/** The hero's own words, so the page's title and summary claim nothing it does not. */
const LANDING_TITLE = "Reverie — Tonight, make a film.";
const LANDING_DESCRIPTION =
  "Alone, or live with the people in the room. Then watch it on the same shelf as 27,839 real ones.";

type LandingDocument = { markup: string; stylesheets: readonly string[] };

/**
 * The static landing page: its markup, its stylesheet, and no script. Fonts are not preloaded:
 * measured on a throttled phone, preloading them delayed the first paint by about 250 ms to
 * spare a swap that moves the hero by a few pixels.
 */
export function landingDocument({ markup, stylesheets }: LandingDocument): string {
  const head = [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<meta name="theme-color" content="#090c17" />',
    `<meta name="description" content="${LANDING_DESCRIPTION}" />`,
    `<title>${LANDING_TITLE}</title>`,
    '<link rel="preconnect" href="https://image.tmdb.org" />',
    ...stylesheets.map((href) => `<link rel="stylesheet" href="${href}" />`),
  ];
  return `<!doctype html>\n<html lang="en">\n  <head>\n    ${head.join("\n    ")}\n  </head>\n  <body>\n    ${markup}\n  </body>\n</html>\n`;
}

export function landingPage(): Plugin {
  let config: ResolvedConfig;
  let env: NodeJS.ProcessEnv = {};
  let required = false;
  let build: Promise<LandingBuild> | null = null;
  let films: Promise<LandingFilms> | null = null;

  const landingBuild = () => {
    build ??= runnerImport<LandingBuild>(resolve(config.root, BUILD_MODULE), {
      root: config.root,
      configFile: false,
      logLevel: "error",
    }).then(({ module }) => module);
    return build;
  };

  const readFilms = async (): Promise<LandingFilms> => {
    const { readLandingFilms, NO_LANDING_FILMS } = await landingBuild();
    const result = await readLandingFilms(env);
    if (result.status === "ok") return result.films;
    const message = `The landing page has no catalogue films: ${result.reason}.`;
    if (required) throw new Error(`${message} A deployed landing must show real films.`);
    config.logger.warn(`${message} It renders without its poster rows.`);
    return NO_LANDING_FILMS;
  };

  return {
    name: "reverie:landing",
    configResolved(resolved) {
      config = resolved;
      env = { ...loadEnv(resolved.mode, resolved.envDir || resolved.root, ""), ...process.env };
      required = resolved.command === "build" && process.env.VERCEL === "1";
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      films ??= readFilms();
      return `export default ${JSON.stringify(await films)};`;
    },
    async writeBundle(options, bundle) {
      if (config.command !== "build" || !films) return;
      const outDir = options.dir ?? resolve(config.root, config.build.outDir);
      const route = Object.values(bundle).find((output) => output.type === "chunk" && LANDING_ROUTE.test(output.facadeModuleId ?? ""));
      const stylesheets = route?.type === "chunk" ? [...(route.viteMetadata?.importedCss ?? [])] : [];
      if (stylesheets.length === 0) throw new Error("The landing's stylesheet is not in the bundle.");

      const { renderLanding } = await landingBuild();
      const markup = renderLanding(await films);

      const shell = await readFile(join(outDir, "index.html"), "utf8");
      await writeFile(join(outDir, APP_SHELL), shell);
      await writeFile(join(outDir, "index.html"), landingDocument({
        markup,
        stylesheets: stylesheets.map((file) => `${config.base}${file}`),
      }));
    },
  };
}
