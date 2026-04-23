// Supabase Edge Function: vision-analyze
// Deploy: supabase functions deploy vision-analyze
// Secrets: supabase secrets set OPENAI_API_KEY=sk-...
//
// Request:  POST {
//   image_base64: string,
//   catalog?: string[],
//   references?: [{ product, image_url }],
//   skip_verify?: boolean
// }
// Response: { detections: [...], warnings: [...], meta: {...} }
//
// Accuracy strategy (2026-04):
//   1. Per-bottle enumeration — we ask the model to list EVERY individual
//      bottle it sees (one array entry per physical bottle), not aggregate
//      counts. We aggregate deterministically in code. This eliminates the
//      "round number bias" LLMs show when asked for counts directly.
//   2. Shelf-row anchoring — each bottle carries shelf_row + position
//      ("left/center/right") + depth ("front/back") which forces systematic
//      scanning and makes duplicates easier to detect.
//   3. Self-verification pass — after the first call we send the answer
//      back with a "what did you miss or double-count?" prompt. Additions
//      are merged (deduped by key); flagged duplicates are removed.
//      Opt-out via VISION_SELF_VERIFY=0 or request { skip_verify: true }.
//   4. Reference gallery inlined as base64 data URLs so OpenAI doesn't need
//      to reach Supabase storage.

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY')
const MODEL = Deno.env.get('OPENAI_VISION_MODEL') ?? 'gpt-4o'
const SELF_VERIFY = (Deno.env.get('VISION_SELF_VERIFY') ?? '1') !== '0'

const SYSTEM_PROMPT = `You are a meticulous bar/stock-room inventory counter.

GOAL
Given a SHELF photo (the target) and optionally a REFERENCE GALLERY of
individual bottle photos (known products, each labeled with a product name),
enumerate EVERY visible bottle in the shelf photo as its own record.

CRITICAL: DO NOT AGGREGATE. LIST EVERY BOTTLE INDIVIDUALLY.
You must produce ONE array entry per physical bottle you see in the photo.
If there are twelve bottles of Tito's on the top shelf, you return TWELVE
separate entries (not one entry with count=12). Aggregation is done by
downstream code, not by you.

HOW TO USE THE REFERENCE GALLERY
  - Each reference image shows ONE bottle of a known product with its name.
  - When a shelf bottle visually matches a reference (same label artwork,
    bottle shape, glass color, cap color), COPY THE REFERENCE'S EXACT
    product name verbatim and set matched_reference = true.
  - The reference gallery is your ground-truth naming. Prefer reference
    names over guesses based on partial labels.
  - If a shelf bottle does NOT match any reference, describe it using
    whatever label text is readable.

SCANNING PROCEDURE (follow in order)
  1. Count shelf rows from top to bottom and label them: shelf_row = 1 for
     the top shelf, 2 for the next, etc. If the photo shows only a single
     row/surface, use shelf_row = 1 for all bottles.
  2. For each shelf_row, scan left to right, front row first, then the row
     directly behind it. Every bottle whose label OR silhouette is visible
     gets its own entry. Bottles partially occluded still count.
  3. For each bottle, set position = "left" | "center" | "right" describing
     its approximate horizontal location on its shelf. Use depth = "front"
     or "back" if you can tell which row it's in.
  4. Two bottles are the SAME product when they share brand/label artwork,
     bottle shape, glass color, cap color, AND apparent size. If any of
     those differ, they are separate products — name them differently.

FILL LEVEL
For each bottle, one of: 1 (full/unopened), 0.5 (about half), 0.1 (nearly
empty), 0 (empty). When in doubt for an unopened-looking bottle, use 1.

OUTPUT — ONE ENTRY PER PHYSICAL BOTTLE
{
  "bottles": [
    {
      "product": "Ilegal Mezcal Joven 750ml",
      "fill_level": 1,
      "shelf_row": 1,
      "position": "left",
      "depth": "front",
      "confidence": 0.9,
      "matched_reference": true,
      "barcode": null,
      "notes": "black cap, green glass"
    }
  ],
  "warnings": []
}

Before returning, count the array length and mentally confirm it matches
the total bottles visible in the shelf photo. Return STRICT JSON only, no
prose, no markdown.`

const VERIFY_PROMPT = `You previously produced an inventory of a shelf photo.
Re-examine the same shelf photo with fresh eyes. Your ONLY job now is to
find errors in the prior answer.

Look specifically for:
  (a) Bottles you missed — partially occluded bottles, back-row bottles,
      bottles at the edges of the image, twins of products you already
      identified but on a different shelf or position.
  (b) Duplicates you double-counted — the same physical bottle that was
      entered twice (e.g. once under a descriptive name and once under a
      reference name). Bottles that appear identical AND share the same
      shelf_row AND position are almost certainly duplicates.

Return STRICT JSON:
{
  "additional_bottles": [ /* same schema as a bottle entry */ ],
  "remove_indices":    [ /* 0-based indices from the prior bottles[]
                           array that should be removed as duplicates */ ]
}

If the prior answer is perfect, return
{ "additional_bottles": [], "remove_indices": [] }.
No prose, no markdown, JSON only.`

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

interface BottleEntry {
  product: string
  fill_level: number
  shelf_row?: number
  position?: string
  depth?: string
  confidence?: number
  matched_reference?: boolean
  barcode?: string | null
  notes?: string | null
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

function normalizeBottle(raw: any): BottleEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const product = String(raw.product ?? raw.name ?? '').trim()
  if (!product) return null
  return {
    product,
    fill_level: snapFill(raw.fill_level ?? raw.fill ?? 1),
    shelf_row: typeof raw.shelf_row === 'number' ? raw.shelf_row : undefined,
    position: typeof raw.position === 'string' ? raw.position : undefined,
    depth: typeof raw.depth === 'string' ? raw.depth : undefined,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
    matched_reference: !!raw.matched_reference,
    barcode: raw.barcode ? String(raw.barcode) : null,
    notes: raw.notes ? String(raw.notes) : null,
  }
}

/** Aggregate per-bottle list into (product × fill_level) detection rows. */
function aggregate(bottles: BottleEntry[]) {
  const bucket = new Map<string, {
    product: string
    count: number
    fill_level: number
    confidenceSum: number
    confidenceCount: number
    barcode: string | null
    notes: string | null
    matched_reference: boolean
  }>()
  for (const b of bottles) {
    const key = `${b.product.toLowerCase()}|${b.fill_level}`
    const existing = bucket.get(key)
    if (!existing) {
      bucket.set(key, {
        product: b.product,
        count: 1,
        fill_level: b.fill_level,
        confidenceSum: b.confidence ?? 0.7,
        confidenceCount: 1,
        barcode: b.barcode ?? null,
        notes: b.notes ?? null,
        matched_reference: !!b.matched_reference,
      })
    } else {
      existing.count += 1
      existing.confidenceSum += b.confidence ?? 0.7
      existing.confidenceCount += 1
      if (!existing.barcode && b.barcode) existing.barcode = b.barcode
      if (b.matched_reference) existing.matched_reference = true
    }
  }
  return Array.from(bucket.values()).map((x) => ({
    product: x.product,
    count: x.count,
    fill_level: x.fill_level,
    confidence: Math.round((x.confidenceSum / x.confidenceCount) * 100) / 100,
    barcode: x.barcode,
    notes: x.notes
      ? x.matched_reference
        ? `${x.notes} · matched reference`
        : x.notes
      : x.matched_reference
        ? 'matched reference'
        : null,
  }))
}

/** Cheap per-bottle identity for dedup between primary + verify bottles. */
function bottleKey(b: BottleEntry): string {
  return [
    b.product.toLowerCase(),
    b.fill_level,
    b.shelf_row ?? '',
    (b.position ?? '').toLowerCase(),
    (b.depth ?? '').toLowerCase(),
  ].join('|')
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
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        const b64 = btoa(binary)
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!OPENAI_KEY) return json({ error: 'OPENAI_API_KEY not configured' }, 500)

  let payload: {
    image_base64?: string
    catalog?: string[]
    references?: Array<{ product: string; image_url: string }>
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

  const catalog = Array.isArray(payload.catalog) ? payload.catalog.slice(0, 500) : []
  const catalogLine = catalog.length
    ? `Known catalog (prefer matching to these names when plausible): ${catalog.join(', ')}.`
    : 'Analyze this shelf photo.'

  const rawRefs = Array.isArray(payload.references)
    ? payload.references
        .filter((r) => r && typeof r.product === 'string' && typeof r.image_url === 'string')
        .slice(0, 25)
    : []

  const inlinedRefs = rawRefs.length ? await fetchReferenceImages(rawRefs) : []

  const shelfImagePart = {
    type: 'image_url' as const,
    image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'high' as const },
  }

  const userContent: any[] = [{ type: 'text', text: catalogLine }]
  if (inlinedRefs.length) {
    userContent.push({
      type: 'text',
      text: `REFERENCE GALLERY (${inlinedRefs.length} known products). Use these as ground-truth naming when a shelf bottle matches.`,
    })
    inlinedRefs.forEach((ref, i) => {
      userContent.push({ type: 'text', text: `Reference #${i + 1}: ${ref.product}` })
      userContent.push({
        type: 'image_url',
        image_url: { url: ref.dataUrl, detail: 'low' },
      })
    })
  }
  userContent.push({ type: 'text', text: 'SHELF PHOTO (target — enumerate every bottle):' })
  userContent.push(shelfImagePart)

  // --- Pass 1: enumerate every bottle ---
  let primary: any
  try {
    primary = await callOpenAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ])
  } catch (e: any) {
    return json({ error: 'openai_failed', detail: String(e).slice(0, 500) }, 502)
  }

  let bottles: BottleEntry[] = Array.isArray(primary?.bottles)
    ? (primary.bottles.map(normalizeBottle).filter(Boolean) as BottleEntry[])
    : []
  const warnings: string[] = Array.isArray(primary?.warnings)
    ? primary.warnings.map(String)
    : []

  const meta: any = {
    model: MODEL,
    reference_count: inlinedRefs.length,
    pass1_bottles: bottles.length,
    verified: false,
  }

  // --- Pass 2: self-verification ---
  const doVerify = SELF_VERIFY && !payload.skip_verify && bottles.length > 0
  if (doVerify) {
    try {
      const priorSummary = JSON.stringify(
        bottles.map((b, i) => ({
          index: i,
          product: b.product,
          fill_level: b.fill_level,
          shelf_row: b.shelf_row,
          position: b.position,
          depth: b.depth,
        }))
      )
      const verifyUser: any[] = [
        { type: 'text', text: `Prior answer (indexed): ${priorSummary}` },
        { type: 'text', text: 'SHELF PHOTO (the same one):' },
        shelfImagePart,
      ]
      const verify = await callOpenAI([
        { role: 'system', content: VERIFY_PROMPT },
        { role: 'user', content: verifyUser },
      ])

      const additions: BottleEntry[] = Array.isArray(verify?.additional_bottles)
        ? (verify.additional_bottles.map(normalizeBottle).filter(Boolean) as BottleEntry[])
        : []
      const removeIdxRaw: any[] = Array.isArray(verify?.remove_indices)
        ? verify.remove_indices
        : []
      const removeIdx = new Set<number>(
        removeIdxRaw
          .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
          .filter((n) => Number.isFinite(n))
      )

      const existingKeys = new Set(bottles.map(bottleKey))
      const uniqueAdditions = additions.filter((a) => !existingKeys.has(bottleKey(a)))

      const removed = removeIdx.size
      bottles = bottles.filter((_, i) => !removeIdx.has(i)).concat(uniqueAdditions)

      meta.verified = true
      meta.added = uniqueAdditions.length
      meta.removed = removed
      meta.pass2_bottles = bottles.length
    } catch (e: any) {
      warnings.push(`verify_pass_skipped: ${String(e).slice(0, 200)}`)
    }
  }

  const detections = aggregate(bottles)
  meta.total_bottles = bottles.length

  return json({ detections, warnings, meta })
})
