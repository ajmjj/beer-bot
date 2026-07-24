// Supabase writer. Used by both the live bot and the backfill importer.
import { createClient } from "@supabase/supabase-js";
import { maskPhone } from "./parser.js";
import { dbLog } from "./logger.js";

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
  const t0 = Date.now();

  // Dedupe by message: skip any entry whose wa_message_id is already recorded. Without
  // this, a redelivered original re-inserts at a number an edit had freed up, creating a
  // phantom second row for the one message. Entries without an id (backfill/manual) pass through.
  // ponytail: app-level check, tiny race window; fine for the single-process bot.
  const ids = entries.map((e) => e.wa_message_id).filter(Boolean);
  if (ids.length) {
    const { data: existing, error: exErr } = await supabase.from("beers").select("wa_message_id").in("wa_message_id", ids);
    if (exErr) throw exErr;
    const seen = new Set((existing ?? []).map((r) => r.wa_message_id));
    entries = entries.filter((e) => !e.wa_message_id || !seen.has(e.wa_message_id));
    if (!entries.length) {
      dbLog.debug({ op: "insertBeers", attempted: ids.length, inserted: 0, skipped: "duplicate wa_message_id", ms: Date.now() - t0 }, "db write");
      return 0;
    }
  }

  const rows = entries.map((e) => ({
    beer_number: e.beer_number,
    member: maskPhone(e.member),
    push_name: e.push_name ?? null, // null for backfill/manual; set on live
    participant: e.participant?.trim() || null, // trim: manual inserts have pasted ids with stray whitespace
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
  dbLog.debug({ op: "insertBeers", attempted: rows.length, inserted: data?.length ?? 0, ms: Date.now() - t0 }, "db write");
  return data?.length ?? 0; // only newly-inserted rows come back
}

// Overwrite who a beer is attributed to (the chat message is ground truth). Returns the
// row if changed, else null. Targets beer_number so it works for any source.
export async function correctBeerMember(beerNumber, { participant, pushName, member }) {
  const t0 = Date.now();
  const { data, error } = await supabase.from("beers")
    .update({ participant, push_name: pushName ?? null, member: maskPhone(member) })
    .eq("beer_number", beerNumber)
    .select("beer_number, member");
  if (error) throw error;
  dbLog.debug({ op: "correctBeerMember", beer: beerNumber, changed: !!data?.length, ms: Date.now() - t0 }, "db write");
  return data?.[0] ?? null;
}

// Handle a message edit. If newBeerNumber is null, hard-delete the row. Otherwise update it
// (or insert if the original message wasn't tracked).
// Returns { action: 'deleted'|'updated'|'inserted'|'conflict'|'noop', beer }
// 'conflict': the new number already belongs to another beer (unique violation) — the
// edit is dropped non-fatally rather than throwing and losing it silently.
export async function handleBeerEdit(waMessageId, newBeerNumber, fields) {
  const t0 = Date.now();
  const done = (result) => {
    dbLog.debug({ op: "handleBeerEdit", id: waMessageId, action: result.action, ms: Date.now() - t0 }, "db write");
    return result;
  };
  const isConflict = (err) => err?.code === "23505"; // Postgres unique_violation on beer_number
  if (newBeerNumber === null) {
    const { data, error } = await supabase.from("beers").delete().eq("wa_message_id", waMessageId).select("beer_number, member");
    if (error) throw error;
    return done({ action: data?.length ? "deleted" : "noop", beer: data?.[0] ?? null });
  }

  // Don't overwrite the original ts: an edit keeps the beer's original day (beer_date).
  const { ts, ...updateFields } = fields;
  const { data: updated, error: ue } = await supabase.from("beers")
    .update({ beer_number: newBeerNumber, ...updateFields })
    .eq("wa_message_id", waMessageId)
    .select("beer_number, member");
  if (ue) { if (isConflict(ue)) return done({ action: "conflict", beer: null }); throw ue; }
  if (updated?.length) return done({ action: "updated", beer: updated[0] });

  // Original message wasn't tracked (was skipped/deleted) — insert fresh (keeps ts).
  const { data: inserted, error: ie } = await supabase.from("beers")
    .insert({ beer_number: newBeerNumber, ...fields, source: "live", wa_message_id: waMessageId })
    .select("beer_number, member");
  if (ie) { if (isConflict(ie)) return done({ action: "conflict", beer: null }); throw ie; }
  return done({ action: inserted?.length ? "inserted" : "noop", beer: inserted?.[0] ?? null });
}

// Sync current group members. participants: [{ participant, phone, is_admin }]
// (participant = lid digits in a lid-addressed group; phone may be null).
// Reconciles against the table: present members are (re)activated, anyone no
// longer in the group is soft-deleted (left_at set). Beers and name resolution
// are preserved — the row stays, just flagged.
export async function syncMembers(participants) {
  if (!participants.length) return 0;
  const t0 = Date.now();
  let merged = 0;
  const now = new Date().toISOString();
  const present = participants.map((p) => p.participant);

  // Legacy merge: rows keyed by phone digits (pre-lid era) become the lid-keyed
  // row for the same person, preserving member/push_name/left_at. One bulk read;
  // the per-row updates fire once ever, then keys.has(p.participant) short-circuits.
  const { data: existing, error: exErr } = await supabase.from("members").select("participant");
  if (exErr) throw exErr;
  const keys = new Set((existing ?? []).map((r) => r.participant));
  for (const p of participants) {
    if (!p.phone || p.phone === p.participant || keys.has(p.participant) || !keys.has(p.phone)) continue;
    await supabase.from("members").update({ participant: p.participant }).eq("participant", p.phone);
    merged++;
  }

  // Two batches: PostgREST bulk upserts need uniform keys, and rows without a
  // known phone must omit the column so they never null-out a stored phone.
  const row = (p, withPhone) => ({
    participant: p.participant,
    ...(withPhone ? { phone: p.phone } : {}),
    is_admin: p.is_admin,
    synced_at: now,
    left_at: null, // present in group → active (also un-leaves anyone who rejoined)
  });
  for (const withPhone of [true, false]) {
    const batch = participants.filter((p) => !!p.phone === withPhone);
    if (!batch.length) continue;
    const { error } = await supabase.from("members").upsert(batch.map((p) => row(p, withPhone)), { onConflict: "participant" });
    if (error) throw error;
  }

  // Soft-delete members who are no longer in the group.
  const { data: left, error: leftErr } = await supabase.from("members")
    .update({ left_at: now })
    .is("left_at", null)
    .not("participant", "in", `(${present.map((p) => `"${p}"`).join(",")})`)
    .select("participant");
  if (leftErr) throw leftErr;

  dbLog.debug({ op: "syncMembers", members: participants.length, merged, left: left?.length ?? 0, ms: Date.now() - t0 }, "db write");
  return participants.length;
}

// Upsert a member row from a live message: sets only the fields we actually
// learned (never clobbers known data with null). Creating missing rows here
// makes members self-healing when syncMembers fails or someone joins, posts
// and leaves between two successful reconciles. A message in the group is
// proof of membership; defaults/trigger fill is_admin, member and left_at.
export async function touchMember({ participant, phone, pushName }) {
  if (!participant) return;
  const fields = { participant };
  if (pushName) fields.push_name = pushName;
  if (phone) fields.phone = phone;
  const t0 = Date.now();
  await supabase.from("members").upsert(fields, { onConflict: "participant" });
  dbLog.debug({ op: "touchMember", participant, fields: Object.keys(fields), ms: Date.now() - t0 }, "db write");
}

// contacts.update carries an id that may be lid- or phone-format; match either
// column. Update-only, so contacts from DMs/other groups never enter the table.
export async function updatePushNameByAnyId(id, pushName) {
  if (!id || !pushName) return;
  const t0 = Date.now();
  await supabase.from("members").update({ push_name: pushName }).or(`participant.eq.${id},phone.eq.${id}`);
  dbLog.debug({ op: "updatePushNameByAnyId", id, pushName, ms: Date.now() - t0 }, "db write");
}

// chats.phoneNumberShare: explicit lid -> phone mapping from the server.
export async function updateMemberPhone(participant, phone) {
  if (!participant || !phone) return;
  const t0 = Date.now();
  await supabase.from("members").upsert({ participant, phone }, { onConflict: "participant" });
  dbLog.debug({ op: "updateMemberPhone", participant, ms: Date.now() - t0 }, "db write");
}

// Last N live beers (with wa_message_id) for startup audit.
export async function getMaxBeerNumber() {
  const t0 = Date.now();
  const { data } = await supabase.from("beers").select("beer_number").order("beer_number", { ascending: false }).limit(1);
  const max = data?.[0]?.beer_number ?? 0;
  dbLog.debug({ op: "getMaxBeerNumber", max, ms: Date.now() - t0 }, "db read");
  return max;
}

export async function getLastBeers(n = 10) {
  const t0 = Date.now();
  const { data, error } = await supabase
    .from("beers")
    .select("beer_number, member, wa_message_id, ts")
    .not("wa_message_id", "is", null)
    .order("beer_number", { ascending: false })
    .limit(n);
  if (error) throw error;
  dbLog.debug({ op: "getLastBeers", count: data?.length ?? 0, ms: Date.now() - t0 }, "db read");
  return data ?? [];
}

// Best-effort display name for a phone number, from any beer that person has posted.
export async function getMemberName(participant) {
  if (!participant) return null;
  const t0 = Date.now();
  const { data } = await supabase
    .from("beers")
    .select("push_name")
    .eq("participant", participant)
    .not("push_name", "is", null)
    .limit(1);
  dbLog.debug({ op: "getMemberName", participant, found: !!data?.length, ms: Date.now() - t0 }, "db read");
  return data?.[0]?.push_name ?? null;
}

// Hard-delete the beer for a revoked WhatsApp message and log it in deleted_beers.
// Returns the matched beer ({ beer_number, member }) or null if it wasn't a tracked live beer.
export async function markBeerDeleted(waMessageId, deletedBy, deletedByName, byAdmin) {
  const t0 = Date.now();
  const { data, error } = await supabase
    .from("beers")
    .delete()
    .eq("wa_message_id", waMessageId)
    .select("beer_number, member, participant");
  if (error) throw error;
  const beer = data?.[0];
  dbLog.debug({ op: "markBeerDeleted", id: waMessageId, matched: !!beer, ms: Date.now() - t0 }, "db write");
  if (!beer) return null;

  const { error: logErr } = await supabase.from("deleted_beers").insert({
    beer_number: beer.beer_number,
    participant: beer.participant,
    deleted_by: deletedByName || deletedBy,
    by_admin: byAdmin,
    wa_message_id: waMessageId,
  });
  if (logErr) throw logErr;
  return beer;
}
