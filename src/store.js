// Supabase writer. Used by both the live bot and the backfill importer.
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY (Supabase secret key) in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// entries: [{ beer_number, member, ts: Date, raw_caption, source }]
// Idempotent: unique(beer_number) + ignoreDuplicates means reruns/overlaps never double-count.
// Returns the number of rows actually inserted.
export async function insertBeers(entries) {
  if (!entries.length) return 0;
  const rows = entries.map((e) => ({
    beer_number: e.beer_number,
    member: e.member,
    ts: e.ts instanceof Date ? e.ts.toISOString() : e.ts,
    raw_caption: e.raw_caption ?? null,
    source: e.source ?? "live",
  }));
  const { data, error } = await supabase
    .from("beers")
    .upsert(rows, { onConflict: "beer_number", ignoreDuplicates: true })
    .select("beer_number");
  if (error) throw error;
  return data?.length ?? 0; // only newly-inserted rows come back
}
