// Supabase writer. Used by both the live bot and the backfill importer.
import { createClient } from "@supabase/supabase-js";
import { maskPhone } from "./parser.js";

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
    member: maskPhone(e.member),
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

// Handle a message edit. If newBeerNumber is null, hard-delete the row. Otherwise update it
// (or insert if the original message wasn't tracked).
// Returns { action: 'deleted'|'updated'|'inserted'|'noop', beer }
export async function handleBeerEdit(waMessageId, newBeerNumber, fields) {
  if (newBeerNumber === null) {
    const { data, error } = await supabase.from("beers").delete().eq("wa_message_id", waMessageId).select("beer_number, member");
    if (error) throw error;
    return { action: data?.length ? "deleted" : "noop", beer: data?.[0] ?? null };
  }

  const { data: updated, error: ue } = await supabase.from("beers")
    .update({ beer_number: newBeerNumber, ...fields })
    .eq("wa_message_id", waMessageId)
    .select("beer_number");
  if (ue) throw ue;
  if (updated?.length) return { action: "updated", beer: updated[0] };

  // Original message wasn't tracked (was skipped) — insert fresh.
  const { data: inserted, error: ie } = await supabase.from("beers")
    .insert({ beer_number: newBeerNumber, ...fields, source: "live", wa_message_id: waMessageId })
    .select("beer_number");
  if (ie) throw ie;
  return { action: inserted?.length ? "inserted" : "noop", beer: inserted?.[0] ?? null };
}

// Sync current group members. participants: [{ participant: string, is_admin: boolean }]
export async function syncMembers(participants) {
  if (!participants.length) return 0;
  const { error } = await supabase.from("members").upsert(
    participants.map((p) => ({
      participant: p.participant,
      phone: p.participant,
      is_admin: p.is_admin,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "participant" },
  );
  if (error) throw error;
  return participants.length;
}

// Keep members.push_name current whenever a live beer comes in.
export async function updateMemberPushName(participant, pushName) {
  if (!participant || !pushName) return;
  await supabase.from("members").update({ push_name: pushName }).eq("participant", participant);
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

// Hard-delete the beer for a revoked WhatsApp message and log it in deleted_beers.
// Returns the matched beer ({ beer_number, member }) or null if it wasn't a tracked live beer.
export async function markBeerDeleted(waMessageId, deletedBy, deletedByName, byAdmin) {
  const { data, error } = await supabase
    .from("beers")
    .delete()
    .eq("wa_message_id", waMessageId)
    .select("beer_number, member");
  if (error) throw error;
  const beer = data?.[0];
  if (!beer) return null;

  const { error: logErr } = await supabase.from("deleted_beers").insert({
    beer_number: beer.beer_number,
    poster: beer.member,
    deleted_by: deletedByName || deletedBy,
    by_admin: byAdmin,
    wa_message_id: waMessageId,
  });
  if (logErr) throw logErr;
  return beer;
}
