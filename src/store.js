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
// Reconciles against the table: present members are (re)activated, anyone no
// longer in the group is soft-deleted (left_at set). Beers and name resolution
// are preserved — the row stays, just flagged.
export async function syncMembers(participants) {
  if (!participants.length) return 0;
  const now = new Date().toISOString();
  const present = participants.map((p) => p.participant);

  const { error } = await supabase.from("members").upsert(
    participants.map((p) => ({
      participant: p.participant,
      is_admin: p.is_admin,
      synced_at: now,
      left_at: null, // present in group → active (also un-leaves anyone who rejoined)
    })),
    { onConflict: "participant" },
  );
  if (error) throw error;

  // Soft-delete members who are no longer in the group.
  const { error: leftErr } = await supabase.from("members")
    .update({ left_at: now })
    .is("left_at", null)
    .not("participant", "in", `(${present.map((p) => `"${p}"`).join(",")})`);
  if (leftErr) throw leftErr;

  return participants.length;
}

// Keep members.push_name current whenever a live beer comes in.
export async function updateMemberPushName(participant, pushName) {
  if (!participant || !pushName) return;
  await supabase.from("members").update({ push_name: pushName }).eq("participant", participant);
}

// When someone posts live, adopt their orphaned backfill rows — old beers with
// no participant that were attributed to the same display name — by stamping
// them with this LID. Retro-links their imported history to their live identity.
// Returns the number of rows claimed.
export async function claimBackfillBeers(participant, pushName) {
  if (!participant || !pushName) return 0;
  const { data, error } = await supabase.from("beers")
    .update({ participant })
    .is("participant", null)
    .ilike("member", pushName) // case-insensitive exact match (names carry no % / _)
    .select("beer_number");
  if (error) throw error;
  return data?.length ?? 0;
}

// Batch version of claimBackfillBeers for when the bot isn't live (e.g. at the
// end of a backfill import). Learns name -> LID from every live (message-id) row,
// then stamps each orphaned backfill row (no participant) whose display name
// matches. Returns the number of rows linked.
export async function reconcileBackfillParticipants() {
  const { data: rows, error } = await supabase
    .from("beers")
    .select("beer_number, participant, wa_message_id, member, push_name");
  if (error) throw error;

  const norm = (s) => (s || "").trim().toLowerCase();
  const nameToLid = {};
  for (const b of rows) {
    if (!b.wa_message_id || !b.participant) continue; // only trust live rows' LID
    for (const n of [b.push_name, b.member]) { const k = norm(n); if (k) nameToLid[k] = b.participant; }
  }

  const byLid = {}; // lid -> [beer_number, ...] to claim
  for (const b of rows) {
    if (b.participant) continue;
    const lid = nameToLid[norm(b.member)];
    if (lid) (byLid[lid] ||= []).push(b.beer_number);
  }

  let claimed = 0;
  for (const [lid, nums] of Object.entries(byLid)) {
    const { error: e } = await supabase.from("beers").update({ participant: lid }).in("beer_number", nums);
    if (e) throw e;
    claimed += nums.length;
  }
  return claimed;
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
