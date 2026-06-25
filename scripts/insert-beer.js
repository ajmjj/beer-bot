// Manually insert a single beer row. Use for bot-missed live beers.
// Usage: node scripts/insert-beer.js <beer_number> <member> <iso_timestamp> [participant]
// Example: node scripts/insert-beer.js 149 "Felix" "2026-06-25T14:35:00" "4915170438574"
import "dotenv/config";
import { insertBeers } from "../src/store.js";

const [beer_number, member, ts, participant] = process.argv.slice(2);
if (!beer_number || !member || !ts) {
  console.error("Usage: node scripts/insert-beer.js <beer_number> <member> <iso_timestamp> [participant]");
  process.exit(1);
}

const inserted = await insertBeers([{ beer_number: parseInt(beer_number, 10), member, ts, participant: participant ?? null, source: "manual" }]);
console.log(inserted ? `inserted #${beer_number}` : `#${beer_number} already exists, skipped`);
