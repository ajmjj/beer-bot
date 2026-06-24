// Supabase writer. Used by both the live bot and the backfill importer.
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY (Supabase secret key) in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// entries: [{ beer_number, member, ts: Date, raw_caption, source, wa_message_id }]
// Idempotent: unique(beer_number) + ignoreDuplicates means reruns/overlaps never double-count.
// Returns the number of rows actually inserted.
export async function insertBeers(entries) {
  if (!entries.length) return 0;
  const rows = entries.map((e) => ({
    beer_number: e.beer_number,
    member: e.member,
    push_name: e.push_name ?? null, // null for backfill/manual; set on live
    participant: e.participant ?? null,
    ts: e.ts instanceof Date ? e.ts.toISOString() : e.ts,
    raw_caption: e.raw_caption ?? null,
    source: e.source ?? "live",
    wa_message_id: e.wa_message_id ?? null,
  }));
  const { data, error } = await supabase
    .from("beers")
    .upsert(rows, { onConflict: "beer_number", ignoreDuplicates: true })
    .select("beer_number");
  if (error) throw error;
  return data?.length ?? 0; // only newly-inserted rows come back
}

// Best-effort display name for a phone number, from any beer that person has posted.
export async function getMemberName(participant) {
  if (!participant) return null;
  const { data } = await supabase
    .from("beers")
    .select("push_name")
    .eq("participant", participant)
    .not("push_name", "is", null)
    .limit(1);
  return data?.[0]?.push_name ?? null;
}

// Soft-delete the beer for a revoked WhatsApp message. Single UPDATE, no second table.
// Returns the matched beer ({ beer_number, member }) or null if it wasn't a tracked live beer.
export async function markBeerDeleted(waMessageId, deletedBy, deletedByName, byAdmin) {
  const { data, error } = await supabase
    .from("beers")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: deletedBy,
      deleted_by_name: deletedByName,
      by_admin: byAdmin,
    })
    .eq("wa_message_id", waMessageId)
    .is("deleted_at", null)
    .select("beer_number, member");
  if (error) throw error;
  return data?.[0] ?? null;
}
