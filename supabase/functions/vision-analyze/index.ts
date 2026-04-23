// Supabase Edge Function: vision-analyze
// Deploy: supabase functions deploy vision-analyze --no-verify-jwt=false
// Secret:  supabase secrets set OPENAI_API_KEY=sk-...
//
// Request:  POST { image_base64: string, catalog?: string[] }
// Response: { detections: [...], warnings: [...] }
//
// The OpenAI key NEVER leaves the server — the mobile app only holds the
// Supabase anon key, which it already has.

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY')
const MODEL = Deno.env.get('OPENAI_VISION_MODEL') ?? 'gpt-4o'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!OPENAI_KEY) return json({ error: 'OPENAI_API_KEY not configured' }, 500)

  let payload: { image_base64?: string; catalog?: string[] }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid json body' }, 400)
  }

  const image = payload.image_base64
  if (!image || typeof image !== 'string') {
    return json({ error: 'image_base64 is required' }, 400)
  }
  // ~10 MB base64 cap to protect from abuse
  if (image.length > 14_000_000) {
    return json({ error: 'image too large' }, 413)
  }

  const catalog = Array.isArray(payload.catalog) ? payload.catalog.slice(0, 500) : []
  const catalogLine = catalog.length
    ? `Known catalog (prefer matching to these names when plausible): ${catalog.join(', ')}.`
    : 'Analyze this shelf photo.'

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: catalogLine },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
          ],
        },
      ],
    }),
  })

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    return json({ error: 'openai_failed', status: upstream.status, detail: text.slice(0, 500) }, 502)
  }

  const data = await upstream.json()
  const content: string = data?.choices?.[0]?.message?.content ?? ''

  let parsed: any = {}
  try {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const body = fenced ? fenced[1] : content
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start !== -1 && end !== -1) parsed = JSON.parse(body.slice(start, end + 1))
  } catch (e) {
    return json({ error: 'parse_failed', detail: String(e), raw: content.slice(0, 500) }, 502)
  }

  return json({
    detections: Array.isArray(parsed.detections) ? parsed.detections : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  })
})
