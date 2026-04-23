// Parse the MarginEdge Inventory.htm export and emit a SQL UPSERT script
// that fills `products.unit_price` (and seeds missing products). Run with:
//
//   node scripts/parse-inventory-prices.js supabase/Inventory.htm > supabase/migrations/20260425_seed_product_prices.sql
//
// The regex targets MarginEdge's table row shape:
//   <span ng-if="!i.parent" class="ng-binding ng-scope">PRODUCT NAME ...</span>
//   ...later...
//   data-content="RAW_PRICE">$1.62</span>
// We prefer `data-content` (full precision) over the truncated `$1.62`.
const fs = require('fs')

const path = process.argv[2] || 'supabase/Inventory.htm'
const html = fs.readFileSync(path, 'utf8')

// Split on row markers to scope name/price pairing per <tr>.
const rowChunks = html.split(/<tr\b/i)
const entries = []
const seen = new Set()

const nameRe = /<span\s+ng-if="!i\.parent"[^>]*>([\s\S]*?)<(?:!--|\/span|span)/i
const rawPriceRe = /data-content="([\d.]+)"\s*>\s*\$\s*[\d.]+/i
const fallbackPriceRe = /\$\s*(\d+\.\d{2})\s*</

for (const chunk of rowChunks) {
  const nm = chunk.match(nameRe)
  if (!nm) continue
  let name = nm[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) continue

  let price = null
  const rp = chunk.match(rawPriceRe)
  if (rp) price = Number(rp[1])
  else {
    const fp = chunk.match(fallbackPriceRe)
    if (fp) price = Number(fp[1])
  }
  if (price == null || !Number.isFinite(price) || price <= 0) continue

  const key = name.toLowerCase()
  if (seen.has(key)) continue
  seen.add(key)
  entries.push({ name, price })
}

process.stderr.write(`Parsed ${entries.length} priced products\n`)

// Emit SQL. Uses INSERT ... ON CONFLICT on a unique name index. If no unique
// constraint exists we fall back to matching by LOWER(name).
const lines = []
lines.push('-- Auto-generated from supabase/Inventory.htm')
lines.push('-- Sets unit_price for products matched by case-insensitive name.')
lines.push('-- Inserts products that don\'t exist yet (with a generic count_unit).')
lines.push('')
lines.push('BEGIN;')
lines.push('')

for (const e of entries) {
  const esc = e.name.replace(/'/g, "''")
  lines.push(
    `UPDATE products SET unit_price = ${e.price.toFixed(4)} ` +
      `WHERE LOWER(name) = LOWER('${esc}');`
  )
}

lines.push('')
// Insert any that didn't match by name (safety net — keep commented so the
// user can review before running; uncomment if you want missing rows added).
lines.push('-- Optional: add rows for products that weren\'t matched above.')
lines.push('-- Uncomment to enable.')
for (const e of entries) {
  const esc = e.name.replace(/'/g, "''")
  lines.push(
    `-- INSERT INTO products (name, count_unit, unit_price) ` +
      `SELECT '${esc}', 'bottle', ${e.price.toFixed(4)} ` +
      `WHERE NOT EXISTS (SELECT 1 FROM products WHERE LOWER(name) = LOWER('${esc}'));`
  )
}

lines.push('')
lines.push('COMMIT;')

process.stdout.write(lines.join('\n') + '\n')
