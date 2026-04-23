import Constants from 'expo-constants'
import { supabase } from './supabase'
import type {
  FillLevel,
  VisionAnalysisResponse,
  VisionDetectionResult,
} from './types'

/**
 * Bottle detection + fill-level estimation via a vision model.
 *
 * Priority:
 *   1. If `extra.visionEndpoint` is configured, POST the image there.
 *      Expected response: { detections: VisionDetectionResult[] }
 *   2. Otherwise, if `extra.openaiApiKey` is configured, call OpenAI
 *      Chat Completions with a vision-capable model directly.
 *
 * Fill buckets used by the MVP:
 *   1.0  -> full / unopened
 *   0.5  -> roughly half
 *   0.1  -> nearly empty
 *   0    -> empty
 */

const FILL_BUCKETS: FillLevel[] = [1, 0.5, 0.1, 0]

export interface BottleReference {
  id: string
  product_name: string
  image_url: string
  priority?: number | null
  notes?: string | null
}

/**
 * Fetch reference bottle photos from the `bottle_references` table, ordered
 * by priority (lower = more important). Returned images are cross-referenced
 * by the vision model to improve naming + duplicate counting.
 * Non-fatal: returns [] on any failure.
 */
export async function fetchBottleReferences(limit = 25): Promise<BottleReference[]> {
  try {
    const { data, error } = await supabase
      .from('bottle_references' as any)
      .select('id, product_name, image_url, priority, notes')
      .order('priority', { ascending: true })
      .order('product_name', { ascending: true })
      .limit(limit)
    if (error) {
      console.warn('[vision] fetchBottleReferences failed:', error.message)
      return []
    }
    return (data ?? []) as BottleReference[]
  } catch (e) {
    console.warn('[vision] fetchBottleReferences threw:', e)
    return []
  }
}

const SYSTEM_PROMPT = `You are a meticulous bar/stock-room inventory counter.
GOAL: Given a shelf photo, count EVERY visible bottle and group by distinct product.

COUNTING RULES (critical — these are commonly missed):
  1. Scan the ENTIRE image systematically: top-to-bottom, left-to-right, then back-to-front.
     Bottles behind other bottles still count.
  2. Two bottles are the SAME product when they share: brand/label artwork, bottle shape,
     glass color, cap color, AND apparent size. All four must match. If any differ, they
     are separate products.
  3. Duplicates are NOT always adjacent. Explicitly search the whole shelf for each label
     you've identified before finalizing its count.
  4. Before you answer, re-scan the image and verify each count by pointing (mentally) at
     every bottle contributing to it. If your first pass said count=1, look again to make
     sure no twin is elsewhere on the shelf.
  5. Bottles partially hidden behind others still count if you can see enough of the label
     or silhouette to identify them.
  6. If several bottles of the same product have different fill levels, split into
     separate entries (one per fill level).

OUTPUT (one entry per distinct product × fill_level combination):
  - product: short human name with size if visible ("Ilegal Mezcal Joven 750ml")
  - count: integer total bottles of that product at that fill level
  - fill_level: 1 (full/unopened), 0.5 (about half), 0.1 (nearly empty), or 0 (empty)
  - confidence: 0-1 self-reported
  - barcode: digits if legible, else null
  - notes: label text, cap color, or disambiguator if low confidence

Before outputting, internally tally: sum of all "count" values should equal the total
bottles visible in the image. If it doesn't, re-scan.

Return STRICT JSON only:
{"detections":[{"product":"...","count":1,"fill_level":1,"confidence":0.8,"barcode":null,"notes":""}],"warnings":[]}
No prose, no markdown, JSON only.`

function snapFill(value: unknown): FillLevel {
  const n = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(n)) return 1
  let best: FillLevel = 1
  let bestDelta = Infinity
  for (const bucket of FILL_BUCKETS) {
    const d = Math.abs(n - bucket)
    if (d < bestDelta) {
      bestDelta = d
      best = bucket
    }
  }
  return best
}

function normalizeDetection(raw: any): VisionDetectionResult | null {
  if (!raw || typeof raw !== 'object') return null
  const product = String(raw.product ?? raw.name ?? '').trim()
  if (!product) return null
  const count = Math.max(1, Math.round(Number(raw.count ?? 1)))
  return {
    product,
    count,
    fill_level: snapFill(raw.fill_level ?? raw.fill ?? 1),
    confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
    barcode: raw.barcode ? String(raw.barcode) : null,
  }
}

function parseJsonBlock(text: string): any {
  // strip ```json fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response')
  return JSON.parse(body.slice(start, end + 1))
}

async function callVisionEndpoint(
  endpoint: string,
  imageBase64: string,
  catalogHint: string[],
  references: BottleReference[]
): Promise<any> {
  const extra: any = Constants.expoConfig?.extra ?? {}
  const anonKey: string | undefined = extra.supabaseAnonKey
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Supabase Edge Functions require both headers when verify_jwt is on
  if (anonKey) {
    headers['Authorization'] = `Bearer ${anonKey}`
    headers['apikey'] = anonKey
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image_base64: imageBase64,
      catalog: catalogHint,
      references: references.map((r) => ({ product: r.product_name, image_url: r.image_url })),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Vision endpoint failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json()
}

async function callOpenAIVision(
  apiKey: string,
  imageBase64: string,
  catalogHint: string[]
): Promise<any> {
  const catalogLine = catalogHint.length
    ? `Known catalog (prefer matching to these names when plausible): ${catalogHint.join(', ')}.`
    : ''
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: catalogLine || 'Analyze this shelf photo.' },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI vision failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  const content = json?.choices?.[0]?.message?.content ?? ''
  return parseJsonBlock(content)
}

export async function analyzeShelfImage(
  imageBase64: string,
  catalogHint: string[] = []
): Promise<VisionAnalysisResponse> {
  const extra: any = Constants.expoConfig?.extra ?? {}
  const visionEndpoint: string | undefined = extra.visionEndpoint
  const openaiKey: string | undefined = extra.openaiApiKey

  // Pull reference images (capped server-side to 25). Failures are non-fatal.
  const references = await fetchBottleReferences(25)

  let raw: any
  if (visionEndpoint) {
    raw = await callVisionEndpoint(visionEndpoint, imageBase64, catalogHint, references)
  } else if (openaiKey) {
    raw = await callOpenAIVision(openaiKey, imageBase64, catalogHint)
  } else {
    throw new Error(
      'No vision backend configured. Set expo.extra.visionEndpoint or expo.extra.openaiApiKey in app.json.'
    )
  }

  const rawDetections: any[] = Array.isArray(raw?.detections) ? raw.detections : []
  const detections = rawDetections
    .map(normalizeDetection)
    .filter((d): d is VisionDetectionResult => d !== null)

  return {
    detections,
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.map(String) : [],
  }
}

/**
 * Merge detections across multiple photos by (product, fill_level).
 * Counts SUM across photos — assumption is that a session's photos
 * cover different shelf sections. If two photos of the same shelf
 * slightly overlap, a handful of bottles may double-count; the user
 * can edit the count on the review screen.
 */
export function mergeDetections(
  groups: VisionDetectionResult[][]
): VisionDetectionResult[] {
  const bucket = new Map<string, VisionDetectionResult>()
  for (const group of groups) {
    for (const d of group) {
      // Normalize name so "Tito's Vodka" and "tito's vodka " collapse.
      const normProduct = d.product.trim().replace(/\s+/g, ' ')
      const key = `${normProduct.toLowerCase()}|${d.fill_level}`
      const existing = bucket.get(key)
      if (!existing) {
        bucket.set(key, { ...d, product: normProduct })
      } else {
        existing.count += d.count
        if ((d.confidence ?? 0) > (existing.confidence ?? 0)) {
          existing.confidence = d.confidence
        }
        if (!existing.barcode && d.barcode) existing.barcode = d.barcode
      }
    }
  }
  return Array.from(bucket.values())
}
