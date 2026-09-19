// Live check of the constraint-aware catalogue shortlist.
//
// Signs in anonymously with the public anon key and calls search_catalogue_titles exactly as
// the catalogue endpoint does, under RLS. Every assertion passes only if the migration is
// applied and the filters really run in the database:
//
//   node --env-file-if-exists=.env.local scripts/verify-shortlist.mjs
//
// It reads no more than one shortlist per step and prints totals, never credentials.

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY.");
  process.exit(2);
}

const client = createClient(url, anonKey, { auth: { persistSession: false } });
const { error: signInError } = await client.auth.signInAnonymously();
if (signInError) throw new Error(`Anonymous sign-in failed: ${signInError.message}`);

async function shortlist(label, filters) {
  const { data, error } = await client.rpc("search_catalogue_titles", { search: "", page_number: 1, page_size: 48, ...filters });
  if (error) throw new Error(`${label}: ${error.message}`);
  console.log(`${label.padEnd(34)} total ${String(data.total).padStart(6)}  rows ${data.items.length}`);
  return data;
}

const all = await shortlist("unrefined", {});
const scary = await shortlist("+ something scary", { include_genres: ["horror"] });
const short = await shortlist("+ under two hours", { include_genres: ["horror"], max_runtime: 119 });
const rejectedId = short.items[0].id;
const rejected = await shortlist("+ not this one", { include_genres: ["horror"], max_runtime: 119, exclude_ids: [rejectedId] });
const widened = await shortlist("- under two hours", { include_genres: ["horror"], exclude_ids: [rejectedId] });
const refused = await shortlist("nothing scary", { exclude_genres: ["horror"] });
const nineties = await shortlist("from the nineties", { min_year: 1990, max_year: 1999 });
const oversized = await shortlist("page size 500 requested", { page_size: 500 });

assert.ok(scary.total < all.total, "wanting horror narrows the catalogue");
assert.ok(scary.items.every((row) => /\bHorror\b/.test(row.genres ?? "")), "every row carries a wanted genre");
assert.ok(short.total < scary.total, "a runtime limit narrows it further");
assert.ok(short.items.every((row) => row.runtime >= 1 && row.runtime <= 119), "no row breaks the runtime limit");
assert.equal(rejected.total, short.total - 1, "a turned-down title is removed");
assert.ok(!rejected.items.some((row) => row.id === rejectedId), "and does not come back");
assert.ok(widened.total > rejected.total, "withdrawing the runtime limit widens the result");
assert.ok(!widened.items.some((row) => row.id === rejectedId), "the turned-down title stays gone");
assert.equal(refused.total + scary.total, all.total, "refusing horror removes exactly the horror titles");
assert.ok(nineties.items.every((row) => row.release_date >= "1990-01-01" && row.release_date <= "1999-12-31"));
assert.ok(oversized.items.length <= 50, "never more than 50 rows");
assert.ok(all.items.every((row) => "original_language" in row), "rows carry their language");
assert.deepEqual(
  Object.keys(all.items[0]).sort(),
  ["backdrop_path", "genres", "id", "original_language", "overview", "poster_path", "release_date", "runtime", "title"],
  "only the columns Discover maps",
);

const languages = [...new Set(all.items.map((row) => row.original_language))];
console.log(`languages on the first shortlist: ${languages.join(" ")}`);
console.log("PASS constraint-aware shortlist");
