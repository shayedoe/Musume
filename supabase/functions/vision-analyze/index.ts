// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { decode, Image } from 'https://deno.land/x/imagescript@1.2.17/mod.ts'

const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY')
const MODEL = Deno.env.get('OPENAI_VISION_MODEL') ?? 'gpt-4o'
const DEFAULT_GRID = Deno.env.get('VISION_TILE_GRID') ?? '2x2'
const SELF_VERIFY_DEFAULT = (Deno.env.get('VISION_SELF_VERIFY') ?? '0') === '1'

// Roboflow hosted detector (preferred when ROBOFLOW_MODEL is set).
// ROBOFLOW_MODEL format: "<project-slug>/<version>"  e.g. "musume/1"
// Set via:  supabase secrets set ROBOFLOW_MODEL=musume/1
const ROBOFLOW_MODEL = Deno.env.get('ROBOFLOW_MODEL')
const ROBOFLOW_API_KEY = Deno.env.get('ROBOFLOW_API_KEY')
const ROBOFLOW_CONFIDENCE = parseFloat(Deno.env.get('ROBOFLOW_CONFIDENCE') ?? '0.75')
const ROBOFLOW_OVERLAP = parseFloat(Deno.env.get('ROBOFLOW_OVERLAP') ?? '0.3')
const TILE_OVERLAP = 0.1 // 10% overlap so bottles on seams still get counted in at least one tile

const SYSTEM_PROMPT = `You are a meticulous bar/stock-room inventory counter.

GOAL
Given a CROP of a shelf photo (the target) and optionally a REFERENCE GALLERY
of individual bottle photos, list EVERY visible bottle in the crop as its own
record with a bounding box.

ABSOLUTE RULES
  (R1) ONE ENTRY PER PHYSICAL BOTTLE. Never aggregate.
       If you see 7 identical bottles of Tito's, bottles[] has 7 entries.
       Aggregation is done downstream — never by you.
  (R2) EVERY ENTRY NEEDS A BOUNDING BOX in normalized tile-local coords.
       bbox = [x, y, w, h], all in [0,1], where (x,y) is top-left of the
       bottle and (w,h) is its size, relative to the crop you were shown.
       If two of your entries have nearly identical bboxes, you are
       double-counting the SAME physical bottle — delete one.
  (R3) Different bboxes with the same product name are DIFFERENT physical
       bottles and must all remain. Do NOT merge them.

REFERENCE GALLERY (when provided)
  - Each reference image shows ONE bottle of a known product with its name.
  - When a shelf bottle visually matches a reference (same label artwork,
    bottle shape, glass color, cap color), COPY THE REFERENCE'S EXACT
    product name verbatim and set matched_reference = true.
  - Prefer reference names over guesses based on partial labels.

PROCEDURE
  1. Scan the crop systematically: top-to-bottom, left-to-right, front row
     first, then back row. Partially occluded bottles still count if you
     can see enough to identify them.
  2. Two bottles are the SAME PRODUCT when they share brand/label artwork,
     bottle shape, glass color, cap color, AND apparent size. Anything
     that differs makes them different products — name them differently.
  3. For every bottle, produce a bbox tight around its visible silhouette.

FILL LEVEL
For each bottle one of: 1 (full/unopened), 0.5 (about half), 0.1 (nearly
empty), 0 (empty). When in doubt for an unopened bottle use 1.

OUTPUT — one entry per physical bottle, STRICT JSON only:
{
  "bottles": [
    {
      "product": "Ilegal Mezcal Joven 750ml",
      "bbox": [0.12, 0.30, 0.07, 0.55],
      "fill_level": 1,
      "confidence": 0.9,
      "matched_reference": true,
      "barcode": null,
      "notes": "black cap, green glass"
    }
  ],
  "warnings": []
}
No prose, no markdown.`

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

interface GlobalBottle {
  product: string
  fill_level: number
  confidence: number
  matched_reference: boolean
  barcode: string | null
  notes: string | null
  // global normalized bbox (relative to the full, pre-tile image)
  gx: number
  gy: number
  gw: number
  gh: number
  source_tile: string
}

function snapFill(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isFinite(n)) return 1
  const buckets = [1, 0.5, 0.1, 0]
  let best = 1
  let bestDelta = Infinity
  for (const b of buckets) {
    const d = Math.abs(n - b)
    if (d < bestDelta) {
      bestDelta = d
      best = b
    }
  }
  return best
}

// --- base64 helpers for large binary (avoid String.fromCharCode stack blowup) ---
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

interface Tile {
  id: string
  // normalized offsets + size in the full image frame
  ox: number
  oy: number
  ow: number
  oh: number
  base64: string
  mime: string
}

/**
 * Decode a JPEG (or PNG), optionally downscale, slice into a grid of tiles
 * with small overlap. Returns the tile base64 blobs + metadata for
 * coordinate back-transform.
 */
async function tileImage(
  originalBytes: Uint8Array,
  grid: { cols: number; rows: number }
): Promise<Tile[]> {
  const decoded = await decode(originalBytes)
  if (!(decoded instanceof Image)) {
    throw new Error('only static images supported (no GIF/animated)')
  }
  // Downscale if the long edge > 2048 to keep tile encoding fast.
  let img = decoded
  const maxEdge = 2048
  if (Math.max(img.width, img.height) > maxEdge) {
    const scale = maxEdge / Math.max(img.width, img.height)
    img = img.resize(Math.round(img.width * scale), Math.round(img.height * scale))
  }

  const { cols, rows } = grid
  // Single-tile fast path — no re-encoding needed if grid is 1x1 and we
  // didn't resize; otherwise encode a single full tile.
  const tiles: Tile[] = []
  const W = img.width
  const H = img.height

  // size of each cell without overlap
  const cellW = W / cols
  const cellH = H / rows
  const padW = cols > 1 ? cellW * TILE_OVERLAP : 0
  const padH = rows > 1 ? cellH * TILE_OVERLAP : 0

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.max(0, Math.round(c * cellW - padW))
      const y0 = Math.max(0, Math.round(r * cellH - padH))
      const x1 = Math.min(W, Math.round((c + 1) * cellW + padW))
      const y1 = Math.min(H, Math.round((r + 1) * cellH + padH))
      const tw = x1 - x0
      const th = y1 - y0
      if (tw <= 0 || th <= 0) continue
      const tile = img.clone().crop(x0, y0, tw, th)
      const jpeg = await tile.encodeJPEG(85)
      tiles.push({
        id: `r${r + 1}c${c + 1}`,
        ox: x0 / W,
        oy: y0 / H,
        ow: tw / W,
        oh: th / H,
        base64: bytesToBase64(jpeg),
        mime: 'image/jpeg',
      })
    }
  }
  return tiles
}

async function fetchReferenceImages(
  refs: Array<{ product: string; image_url: string }>
): Promise<Array<{ product: string; dataUrl: string }>> {
  const out: Array<{ product: string; dataUrl: string }> = []
  const fetched = await Promise.all(
    refs.map(async (ref) => {
      try {
        const r = await fetch(ref.image_url, {
          signal: AbortSignal.timeout(6000),
          headers: { Accept: 'image/*' },
        })
        if (!r.ok) return null
        const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
        if (!ct.startsWith('image/')) return null
        const bytes = new Uint8Array(await r.arrayBuffer())
        if (bytes.byteLength < 500 || bytes.byteLength > 4_000_000) return null
        const b64 = bytesToBase64(bytes)
        return { product: ref.product, dataUrl: `data:${ct};base64,${b64}` }
      } catch {
        return null
      }
    })
  )
  for (const f of fetched) if (f) out.push(f)
  return out
}

function parseJson(content: string): any {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : content
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1) return {}
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return {}
  }
}

async function callOpenAI(messages: any[]): Promise<any> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`openai ${res.status}: ${text.slice(0, 400)}`)
  }
  const data = await res.json()
  return parseJson(data?.choices?.[0]?.message?.content ?? '')
}

async function analyzeTile(
  tile: Tile,
  inlinedRefs: Array<{ product: string; dataUrl: string }>,
  catalogLine: string
): Promise<GlobalBottle[]> {
  const content: any[] = [{ type: 'text', text: catalogLine }]
  if (inlinedRefs.length) {
    content.push({
      type: 'text',
      text: `REFERENCE GALLERY (${inlinedRefs.length} known products). Use these as ground-truth naming when a shelf bottle matches.`,
    })
    inlinedRefs.forEach((ref, i) => {
      content.push({ type: 'text', text: `Reference #${i + 1}: ${ref.product}` })
      content.push({ type: 'image_url', image_url: { url: ref.dataUrl, detail: 'low' } })
    })
  }
  content.push({
    type: 'text',
    text: `SHELF CROP (tile ${tile.id}). Enumerate every bottle you see with a tight bbox:`,
  })
  content.push({
    type: 'image_url',
    image_url: { url: `data:${tile.mime};base64,${tile.base64}`, detail: 'high' },
  })

  let raw: any
  try {
    raw = await callOpenAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ])
  } catch {
    return []
  }

  const bottlesRaw: any[] = Array.isArray(raw?.bottles) ? raw.bottles : []
  const out: GlobalBottle[] = []
  for (const b of bottlesRaw) {
    if (!b || typeof b !== 'object') continue
    const product = String(b.product ?? b.name ?? '').trim()
    if (!product) continue
    const bbox = Array.isArray(b.bbox) ? b.bbox : null
    let lx = 0,
      ly = 0,
      lw = 1,
      lh = 1
    if (bbox && bbox.length === 4) {
      lx = Math.max(0, Math.min(1, Number(bbox[0])))
      ly = Math.max(0, Math.min(1, Number(bbox[1])))
      lw = Math.max(0, Math.min(1 - lx, Number(bbox[2])))
      lh = Math.max(0, Math.min(1 - ly, Number(bbox[3])))
      if (!Number.isFinite(lx + ly + lw + lh) || lw < 0.01 || lh < 0.05) continue
    }
    // map tile-local normalized -> global normalized
    const gx = tile.ox + lx * tile.ow
    const gy = tile.oy + ly * tile.oh
    const gw = lw * tile.ow
    const gh = lh * tile.oh
    out.push({
      product,
      fill_level: snapFill(b.fill_level ?? b.fill ?? 1),
      confidence: typeof b.confidence === 'number' ? b.confidence : 0.7,
      matched_reference: !!b.matched_reference,
      barcode: b.barcode ? String(b.barcode) : null,
      notes: b.notes ? String(b.notes) : null,
      gx,
      gy,
      gw,
      gh,
      source_tile: tile.id,
    })
  }
  return out
}

/** IoU between two global normalized bboxes. */
function iou(a: GlobalBottle, b: GlobalBottle): number {
  const ax2 = a.gx + a.gw
  const ay2 = a.gy + a.gh
  const bx2 = b.gx + b.gw
  const by2 = b.gy + b.gh
  const ix1 = Math.max(a.gx, b.gx)
  const iy1 = Math.max(a.gy, b.gy)
  const ix2 = Math.min(ax2, bx2)
  const iy2 = Math.min(ay2, by2)
  if (ix2 <= ix1 || iy2 <= iy1) return 0
  const inter = (ix2 - ix1) * (iy2 - iy1)
  const ua = a.gw * a.gh + b.gw * b.gh - inter
  return ua > 0 ? inter / ua : 0
}

// Generic words that must NOT cause two different SKUs to be considered the
// same product during dedupe. Without this, "Nikka Coffey Vodka" and
// "Townes Vodka" share the token "vodka" and get collapsed when their
// bboxes overlap (front-row vs back-row bottle), producing wildly wrong
// counts where one class dominates.
const GENERIC_PRODUCT_TOKENS = new Set([
  'vodka', 'tequila', 'mezcal', 'gin', 'rum', 'whiskey', 'whisky', 'bourbon',
  'scotch', 'cognac', 'brandy', 'liqueur', 'wine', 'champagne', 'beer',
  'reserve', 'reserva', 'extra', 'special', 'premium', 'organic', 'silver',
  'blanco', 'reposado', 'anejo', 'gold', 'black', 'white', 'red',
  'handmade', 'craft', 'distilled', 'spirit', 'spirits', 'bottle',
  '750ml', '1000ml', '1l', '750', '1l', 'ml',
])

function productsMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim()
  const nb = b.toLowerCase().trim()
  if (!na || !nb) return false
  if (na === nb) return true
  // "Unknown bottle" should never collapse with anything else.
  if (na.includes('unknown') || nb.includes('unknown')) return false
  // Strict match: must share a *non-generic* token of length >= 4.
  // "Nikka" / "Townes" / "Belvedere" / "Tito" pass; "vodka" / "premium" don't.
  const tokens = (s: string) =>
    s
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !GENERIC_PRODUCT_TOKENS.has(t))
  const ta = new Set(tokens(na))
  if (ta.size === 0) return false
  for (const t of tokens(nb)) {
    if (ta.has(t)) return true
  }
  return false
}

/** Dedup bottles whose global bbox overlaps significantly AND products plausibly match. */
function dedupe(bottles: GlobalBottle[]): GlobalBottle[] {
  const kept: GlobalBottle[] = []
  for (const b of bottles) {
    let merged = false
    for (const k of kept) {
      // Require substantial overlap before treating as the same physical
      // bottle. Front-row bottles often partially occlude back-row ones
      // (~30% IoU); we don't want those collapsed into one count.
      if (iou(b, k) > 0.55 && productsMatch(b.product, k.product)) {
        // keep the higher-confidence / reference-matched one's product name
        if (!k.matched_reference && b.matched_reference) {
          k.product = b.product
          k.matched_reference = true
        } else if (b.confidence > k.confidence && b.product.length > k.product.length) {
          k.product = b.product
        }
        k.confidence = Math.max(k.confidence, b.confidence)
        if (!k.barcode && b.barcode) k.barcode = b.barcode
        merged = true
        break
      }
    }
    if (!merged) kept.push(b)
  }
  return kept
}

/** Aggregate per-bottle list into (product × fill_level) detection rows. */
function aggregate(bottles: GlobalBottle[]) {
  const bucket = new Map<string, {
    product: string
    count: number
    fill_level: number
    confSum: number
    confCount: number
    barcode: string | null
    matched_reference: boolean
    sampleNote: string | null
  }>()
  for (const b of bottles) {
    const key = `${b.product.toLowerCase()}|${b.fill_level}`
    const existing = bucket.get(key)
    if (!existing) {
      bucket.set(key, {
        product: b.product,
        count: 1,
        fill_level: b.fill_level,
        confSum: b.confidence,
        confCount: 1,
        barcode: b.barcode,
        matched_reference: b.matched_reference,
        sampleNote: b.notes,
      })
    } else {
      existing.count += 1
      existing.confSum += b.confidence
      existing.confCount += 1
      if (!existing.barcode && b.barcode) existing.barcode = b.barcode
      if (b.matched_reference) existing.matched_reference = true
    }
  }
  return Array.from(bucket.values()).map((x) => ({
    product: x.product,
    count: x.count,
    fill_level: x.fill_level,
    confidence: Math.round((x.confSum / x.confCount) * 100) / 100,
    barcode: x.barcode,
    notes: x.sampleNote
      ? x.matched_reference
        ? `${x.sampleNote} · matched reference`
        : x.sampleNote
      : x.matched_reference
        ? 'matched reference'
        : null,
  }))
}

function annotationsFromBottles(bottles: GlobalBottle[]) {
  return bottles.map((b) => {
    const status: 'matched' | 'identified' | 'unknown' =
      b.product.toLowerCase().includes('unknown')
        ? 'unknown'
        : b.matched_reference
          ? 'matched'
          : 'identified'
    return {
      bbox: [
        Math.max(0, Math.min(1, b.gx)),
        Math.max(0, Math.min(1, b.gy)),
        Math.max(0, Math.min(1, b.gw)),
        Math.max(0, Math.min(1, b.gh)),
      ] as [number, number, number, number],
      product: b.product,
      status,
      confidence: b.confidence,
    }
  })
}

function parseGrid(value: string | undefined): { cols: number; rows: number } {
  const v = (value ?? DEFAULT_GRID ?? '2x2').toLowerCase()
  const m = v.match(/^(\d)x(\d)$/)
  if (!m) return { cols: 2, rows: 2 }
  const cols = Math.max(1, Math.min(4, parseInt(m[1], 10)))
  const rows = Math.max(1, Math.min(4, parseInt(m[2], 10)))
  return { cols, rows }
}

interface RoboflowPrediction {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  class: string
  class_id?: number
}

const BOTTLE_ID_CONCURRENCY = 6
const BOTTLE_CROP_PADDING = 0.05 // expand each bbox by 5% so labels aren't clipped

const SKU_ID_PROMPT = `You identify a SINGLE bottle in a close-up crop.

INPUTS
  - One CROP showing one bottle from a bar shelf.
  - A REFERENCE GALLERY of known products, each labeled with a product name.

IDENTIFICATION PROCEDURE (follow in this exact order)
  Step 1 — READ THE LABEL TEXT FIRST.
    Read every legible word/letter on the bottle label and cap. Do this
    BEFORE comparing to references. Example tokens you might read:
    "NIKKA", "COFFEY", "TOWNES", "BELVEDERE", "TITO'S", "OSHE",
    "GREY GOOSE", "GOODNIGHT LOVING", "HANGAR 1", etc.
    If you can read a brand name, that brand WINS over visual similarity.
  Step 2 — Match to a REFERENCE only if the brand text on the crop is
    consistent with the reference. Two bottles can look similar (clear
    glass, dark cap, similar height) and still be DIFFERENT products.
    Never pick a reference whose brand name contradicts text you can read.
  Step 3 — If the label is unreadable AND no reference is a clear visual
    match (label artwork + bottle silhouette + cap + glass color all
    consistent), return product = "Unknown bottle" with low confidence.
    DO NOT guess the most common class on the shelf.

CONFIDENCE
  - 0.85+  : you can read brand text and it matches a reference.
  - 0.6-0.85 : strong visual match to a reference, partial label visible.
  - <0.5   : you are guessing — in this case product MUST be
             "Unknown bottle".

FILL LEVEL
  1 (full/unopened), 0.5 (about half), 0.1 (nearly empty), 0 (empty).

OUTPUT — STRICT JSON only, no prose:
{
  "product": "Nikka Coffey Vodka" OR "Unknown bottle",
  "matched_reference": true,
  "label_text": "NIKKA COFFEY VODKA",
  "fill_level": 1,
  "confidence": 0.9,
  "notes": "black cap, blue label band"
}`

async function identifyBottleCrop(
  cropBytes: Uint8Array,
  inlinedRefs: Array<{ product: string; dataUrl: string }>
): Promise<
  | {
      ok: true
      product: string
      matched_reference: boolean
      fill_level: number
      confidence: number
      notes: string | null
    }
  | { ok: false; reason: string }
> {
  if (!OPENAI_KEY) return { ok: false, reason: 'no OPENAI_API_KEY' }
  const cropDataUrl = `data:image/jpeg;base64,${bytesToBase64(cropBytes)}`

  const content: any[] = []
  if (inlinedRefs.length) {
    content.push({
      type: 'text',
      text: `REFERENCE GALLERY (${inlinedRefs.length} known products). If the crop matches one, use that product name verbatim.`,
    })
    inlinedRefs.forEach((ref, i) => {
      content.push({ type: 'text', text: `Reference #${i + 1}: ${ref.product}` })
      content.push({ type: 'image_url', image_url: { url: ref.dataUrl, detail: 'low' } })
    })
  }
  content.push({ type: 'text', text: 'BOTTLE CROP to identify:' })
  content.push({ type: 'image_url', image_url: { url: cropDataUrl, detail: 'low' } })

  try {
    const raw = await callOpenAI([
      { role: 'system', content: SKU_ID_PROMPT },
      { role: 'user', content },
    ])
    const product = String(raw?.product ?? '').trim()
    if (!product) return { ok: false, reason: 'empty product from model' }
    const confidence =
      typeof raw?.confidence === 'number' ? raw.confidence : 0.7
    // If the model is unsure, demote to "Unknown bottle" rather than
    // letting a low-confidence guess get aggregated as a real SKU. This
    // is the main safeguard against one class (e.g. Nikka) dominating a
    // crowded shelf where many bottles share visual traits.
    const LOW_CONF_FLOOR = 0.5
    const finalProduct =
      product.toLowerCase() === 'unknown bottle' || confidence < LOW_CONF_FLOOR
        ? 'Unknown bottle'
        : product
    const matched_reference =
      finalProduct === 'Unknown bottle' ? false : !!raw?.matched_reference
    const labelText = raw?.label_text ? String(raw.label_text).slice(0, 80) : ''
    const baseNotes = raw?.notes ? String(raw.notes) : null
    const notes = labelText
      ? baseNotes
        ? `${baseNotes} · label: ${labelText}`
        : `label: ${labelText}`
      : baseNotes
    return {
      ok: true,
      product: finalProduct,
      matched_reference,
      fill_level: snapFill(raw?.fill_level ?? 1),
      confidence,
      notes,
    }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) }
  }
}

async function detectWithRoboflow(
  imageBase64: string,
  inlinedRefs: Array<{ product: string; dataUrl: string }>,
  classNameMap: Map<string, string>
): Promise<{
  detections: Array<{
    product: string
    count: number
    fill_level: number
    confidence: number
    barcode: string | null
    notes: string | null
  }>
  annotations: Array<{
    bbox: [number, number, number, number]
    product: string
    status: 'matched' | 'identified' | 'unknown'
    confidence: number
  }>
  warnings: string[]
  meta: Record<string, unknown>
}> {
  const url =
    `https://detect.roboflow.com/${ROBOFLOW_MODEL}` +
    `?api_key=${ROBOFLOW_API_KEY}` +
    `&confidence=${Math.round(ROBOFLOW_CONFIDENCE * 100)}` +
    `&overlap=${Math.round(ROBOFLOW_OVERLAP * 100)}` +
    `&format=json`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: imageBase64,
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`roboflow ${res.status}: ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  const preds: RoboflowPrediction[] = Array.isArray(data?.predictions)
    ? data.predictions
    : []

  // Determine whether the Roboflow model is single-class ("bottle") or
  // multi-class (SKU-level). If single-class, we need to identify each
  // crop via OpenAI. If multi-class, we trust Roboflow's class labels.
  const distinctClasses = new Set(preds.map((p) => (p.class ?? '').toLowerCase().trim()))
  const singleClass =
    distinctClasses.size <= 1 &&
    (distinctClasses.has('bottle') || distinctClasses.has(''))

  let identifiedBottles: Array<{
    product: string
    fill_level: number
    confidence: number
    matched_reference: boolean
    notes: string | null
    pred: RoboflowPrediction
  }> = []
  let idMeta: Record<string, unknown> = {}
  const idWarnings: string[] = []
  // Image dimensions for bbox normalization. Roboflow returns `data.image =
  // { width, height }`; fall back to the decoded shelf image if missing.
  let imgW =
    typeof data?.image?.width === 'number' ? Number(data.image.width) : 0
  let imgH =
    typeof data?.image?.height === 'number' ? Number(data.image.height) : 0

  if (singleClass && preds.length > 0) {
    // Decode shelf image once, then crop per detection.
    let shelfImg: Image
    try {
      const bytes = base64ToBytes(imageBase64)
      const decoded = await decode(bytes)
      if (!(decoded instanceof Image)) throw new Error('unsupported image type')
      shelfImg = decoded
    } catch (e: any) {
      throw new Error(`shelf decode failed: ${String(e).slice(0, 200)}`)
    }
    const W = shelfImg.width
    const H = shelfImg.height
    if (!imgW) imgW = W
    if (!imgH) imgH = H

    // Build crop jobs
    const crops: Array<{ idx: number; bytes: Uint8Array; pred: RoboflowPrediction }> = []
    for (let i = 0; i < preds.length; i++) {
      const p = preds[i]
      // Roboflow returns x,y as bbox CENTER in pixels, width/height in pixels
      const padW = p.width * BOTTLE_CROP_PADDING
      const padH = p.height * BOTTLE_CROP_PADDING
      const x0 = Math.max(0, Math.round(p.x - p.width / 2 - padW))
      const y0 = Math.max(0, Math.round(p.y - p.height / 2 - padH))
      const x1 = Math.min(W, Math.round(p.x + p.width / 2 + padW))
      const y1 = Math.min(H, Math.round(p.y + p.height / 2 + padH))
      const w = x1 - x0
      const h = y1 - y0
      if (w < 20 || h < 40) continue
      try {
        const cropImg = shelfImg.clone().crop(x0, y0, w, h)
        // cap the longer edge to 512 for cheap "low" detail tokens
        let finalImg = cropImg
        if (Math.max(cropImg.width, cropImg.height) > 512) {
          const scale = 512 / Math.max(cropImg.width, cropImg.height)
          finalImg = cropImg.resize(
            Math.round(cropImg.width * scale),
            Math.round(cropImg.height * scale)
          )
        }
        const jpeg = await finalImg.encodeJPEG(80)
        crops.push({ idx: i, bytes: jpeg, pred: p })
      } catch {
        /* skip this crop */
      }
    }

    // Parallel identify with concurrency cap
    const results = new Array<Awaited<ReturnType<typeof identifyBottleCrop>>>(crops.length)
    let cursor = 0
    async function worker() {
      while (true) {
        const myIdx = cursor++
        if (myIdx >= crops.length) return
        results[myIdx] = await identifyBottleCrop(crops[myIdx].bytes, inlinedRefs)
      }
    }
    const workerCount = Math.min(BOTTLE_ID_CONCURRENCY, crops.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    let identifiedCount = 0
    let refMatchCount = 0
    for (let i = 0; i < crops.length; i++) {
      const r = results[i]
      const pred = crops[i].pred
      if (r && r.ok) {
        identifiedCount++
        if (r.matched_reference) refMatchCount++
        identifiedBottles.push({
          product: r.product,
          fill_level: r.fill_level,
          confidence: Math.min(pred.confidence ?? 0.7, r.confidence),
          matched_reference: r.matched_reference,
          notes: r.notes,
          pred,
        })
      } else {
        // OpenAI identification failed — keep the bottle but label as "Unknown bottle"
        const reason = r && !r.ok ? r.reason : 'no response'
        if (idWarnings.length < 3) idWarnings.push(`ID failed: ${reason}`)
        identifiedBottles.push({
          product: 'Unknown bottle',
          fill_level: 1,
          confidence: pred.confidence ?? 0.5,
          matched_reference: false,
          notes: null,
          pred,
        })
      }
    }
    idMeta = {
      crops: crops.length,
      identified: identifiedCount,
      reference_matches: refMatchCount,
      id_failures: crops.length - identifiedCount,
    }
  } else {
    // Multi-class model — trust Roboflow classes as-is.
    for (const p of preds) {
      const raw = String(p.class ?? '').trim()
      if (!raw) continue
      const key = raw.toLowerCase()
      const pretty = classNameMap.get(key) ?? raw
      identifiedBottles.push({
        product: pretty,
        fill_level: 1,
        confidence: p.confidence ?? 0.7,
        matched_reference: classNameMap.has(key),
        notes: null,
        pred: p,
      })
    }
  }

  // Aggregate by (product, fill_level)
  const bucket = new Map<string, {
    product: string
    count: number
    fill_level: number
    confSum: number
    matched_reference: boolean
    notes: string | null
  }>()
  for (const b of identifiedBottles) {
    const key = `${b.product.toLowerCase()}|${b.fill_level}`
    const existing = bucket.get(key)
    if (!existing) {
      bucket.set(key, {
        product: b.product,
        count: 1,
        fill_level: b.fill_level,
        confSum: b.confidence,
        matched_reference: b.matched_reference,
        notes: b.notes,
      })
    } else {
      existing.count += 1
      existing.confSum += b.confidence
      if (b.matched_reference) existing.matched_reference = true
      if (!existing.notes && b.notes) existing.notes = b.notes
    }
  }

  const detections = Array.from(bucket.values()).map((x) => ({
    product: x.product,
    count: x.count,
    fill_level: x.fill_level,
    confidence: Math.round((x.confSum / x.count) * 100) / 100,
    barcode: null as string | null,
    notes: x.matched_reference
      ? x.notes
        ? `${x.notes} · matched reference`
        : 'matched reference'
      : x.notes,
  }))

  // Per-bottle annotations (normalized 0..1 bboxes) for UI overlay.
  // Roboflow returns x,y as center coords + width/height, all in pixels.
  const annotations: Array<{
    bbox: [number, number, number, number]
    product: string
    status: 'matched' | 'identified' | 'unknown'
    confidence: number
  }> = []
  if (imgW > 0 && imgH > 0) {
    for (const b of identifiedBottles) {
      const p = b.pred
      const nx = (p.x - p.width / 2) / imgW
      const ny = (p.y - p.height / 2) / imgH
      const nw = p.width / imgW
      const nh = p.height / imgH
      const status: 'matched' | 'identified' | 'unknown' =
        b.product === 'Unknown bottle'
          ? 'unknown'
          : b.matched_reference
          ? 'matched'
          : 'identified'
      annotations.push({
        bbox: [
          Math.max(0, Math.min(1, nx)),
          Math.max(0, Math.min(1, ny)),
          Math.max(0, Math.min(1, nw)),
          Math.max(0, Math.min(1, nh)),
        ],
        product: b.product,
        status,
        confidence: b.confidence,
      })
    }
  }

  return {
    detections,
    annotations,
    warnings: [
      ...(preds.length === 0 ? ['roboflow returned no detections'] : []),
      ...idWarnings,
    ],
    meta: {
      backend: singleClass ? 'roboflow+openai-id' : 'roboflow',
      model: ROBOFLOW_MODEL,
      raw_predictions: preds.length,
      single_class: singleClass,
      unique_products: bucket.size,
      reference_count: inlinedRefs.length,
      image: data?.image,
      time: data?.time,
      ...idMeta,
    },
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  let payload: {
    image_base64?: string
    catalog?: string[]
    references?: Array<{ product: string; image_url: string }>
    tile_grid?: string
    skip_verify?: boolean
  }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid json body' }, 400)
  }

  const image = payload.image_base64
  if (!image || typeof image !== 'string') return json({ error: 'image_base64 required' }, 400)
  if (image.length > 14_000_000) return json({ error: 'image too large' }, 413)

  let roboflowWarning: string | null = null

  // ---- Roboflow path (preferred when model is configured) ----
  if (ROBOFLOW_MODEL && ROBOFLOW_API_KEY) {
    // Build a class-slug -> pretty-product-name map from the request's
    // reference list + catalog so "titos_vodka" renders as "Tito's Vodka".
    const classNameMap = new Map<string, string>()
    const refs = Array.isArray(payload.references) ? payload.references : []
    for (const r of refs) {
      if (r?.product) classNameMap.set(r.product.toLowerCase().replace(/\s+/g, '_'), r.product)
    }
    const cat = Array.isArray(payload.catalog) ? payload.catalog : []
    for (const name of cat) {
      classNameMap.set(String(name).toLowerCase().replace(/\s+/g, '_'), String(name))
    }
    // Fetch reference images server-side for SKU identification (single-class
    // Roboflow models need OpenAI to name each crop).
    const rfRefs = refs
      .filter((r) => r && typeof r.product === 'string' && typeof r.image_url === 'string')
      .slice(0, 25)
    const inlinedRefs = rfRefs.length ? await fetchReferenceImages(rfRefs) : []

    try {
      const out = await detectWithRoboflow(image, inlinedRefs, classNameMap)
      return json(out)
    } catch (e: any) {
      // If Roboflow fails, fall through to the OpenAI path so the user
      // still gets a result rather than a hard error.
      roboflowWarning = `roboflow failed, fell back to openai: ${String(e).slice(0, 240)}`
      console.warn('[vision-analyze] roboflow failed, falling back to openai:', String(e))
    }
  }

  // ---- OpenAI tiled path (fallback / when no Roboflow model yet) ----
  if (!OPENAI_KEY) return json({ error: 'OPENAI_API_KEY not configured' }, 500)

  const catalog = Array.isArray(payload.catalog) ? payload.catalog.slice(0, 500) : []
  const catalogLine = catalog.length
    ? `Known catalog (prefer matching to these names when plausible): ${catalog.join(', ')}.`
    : 'Analyze this shelf crop.'

  const rawRefs = Array.isArray(payload.references)
    ? payload.references
        .filter((r) => r && typeof r.product === 'string' && typeof r.image_url === 'string')
        .slice(0, 25)
    : []

  const grid = parseGrid(payload.tile_grid)

  // Decode + tile
  let tiles: Tile[]
  try {
    const bytes = base64ToBytes(image)
    tiles = await tileImage(bytes, grid)
  } catch (e: any) {
    return json({ error: 'decode_failed', detail: String(e).slice(0, 300) }, 400)
  }
  if (tiles.length === 0) return json({ error: 'no tiles produced' }, 500)

  // Fetch references once, reuse across all tiles
  const inlinedRefs = rawRefs.length ? await fetchReferenceImages(rawRefs) : []

  // Analyze every tile in parallel
  const perTile = await Promise.all(
    tiles.map((t) => analyzeTile(t, inlinedRefs, catalogLine))
  )
  const allBottles: GlobalBottle[] = perTile.flat()

  // Dedupe bottles that sit in overlap regions (appear in 2 adjacent tiles)
  const beforeDedupe = allBottles.length
  const deduped = dedupe(allBottles)

  const detections = aggregate(deduped)
  const annotations = annotationsFromBottles(deduped)

  const meta = {
    backend: 'openai-tiled',
    model: MODEL,
    grid: `${grid.cols}x${grid.rows}`,
    tiles: tiles.length,
    reference_count: inlinedRefs.length,
    raw_bottles: beforeDedupe,
    deduped_bottles: deduped.length,
    per_tile: tiles.map((t, i) => ({ id: t.id, bottles: perTile[i].length })),
  }

  // Keep response shape backward compatible (detections[] + warnings[])
  return json({ detections, annotations, warnings: roboflowWarning ? [roboflowWarning] : [], meta })
})
