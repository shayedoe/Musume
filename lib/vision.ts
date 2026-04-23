import Constants from 'expo-constants'
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

const SYSTEM_PROMPT = `You are an inventory assistant for a bar / stock room.
Given a shelf photo, identify every visible bottle. For each distinct
product (same brand + size), return ONE entry with:
  - product: short human name ("Tito's Vodka 750ml")
  - count: integer number of bottles of that product visible
  - fill_level: 1 (full/unopened), 0.5 (about half), 0.1 (nearly empty), or 0 (empty)
    - If multiple bottles of the same product have different fill levels,
      split them into separate entries.
  - confidence: 0-1 self-reported confidence
  - barcode: any visible barcode digits, else null
  - notes: label text or disambiguators if unclear

Return STRICT JSON of the form:
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
  catalogHint: string[]
): Promise<any> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: imageBase64, catalog: catalogHint }),
  })
  if (!res.ok) throw new Error(`Vision endpoint failed: ${res.status}`)
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

  let raw: any
  if (visionEndpoint) {
    raw = await callVisionEndpoint(visionEndpoint, imageBase64, catalogHint)
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

/** Merge detections across multiple photos by product + fill level. */
export function mergeDetections(
  groups: VisionDetectionResult[][]
): VisionDetectionResult[] {
  const bucket = new Map<string, VisionDetectionResult>()
  for (const group of groups) {
    for (const d of group) {
      const key = `${d.product.toLowerCase()}|${d.fill_level}`
      const existing = bucket.get(key)
      if (!existing) {
        bucket.set(key, { ...d })
      } else {
        existing.count = Math.max(existing.count, d.count)
        if ((d.confidence ?? 0) > (existing.confidence ?? 0)) {
          existing.confidence = d.confidence
        }
        if (!existing.barcode && d.barcode) existing.barcode = d.barcode
      }
    }
  }
  return Array.from(bucket.values())
}
