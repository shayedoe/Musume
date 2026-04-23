// Supabase Edge Function: seed-references
// Auto-populates the bottle_references table by searching DuckDuckGo Images
// for each product name and uploading the first viable result to the
// `bottle-references` storage bucket.
//
// Deploy:  supabase functions deploy seed-references
// Request: POST { products: string[] }   (max 50 per call)
// Response:{ results: [{product, ok, url?, error?}], summary: {ok, failed} }

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
// Use service role so RLS doesn't block server-side inserts
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Get the DuckDuckGo "vqd" token required to call the image endpoint. */
async function getVqd(query: string): Promise<string | null> {
  const res = await fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iar=images&iax=images&ia=images`,
    { headers: { 'User-Agent': UA, Accept: 'text/html' } }
  )
  const html = await res.text()
  // multiple shapes observed: vqd='1-123...' or vqd="1-123..."
  const m =
    html.match(/vqd\s*=\s*['"]([\d-]+)['"]/) ||
    html.match(/vqd=([\d-]+)&/) ||
    html.match(/"vqd":"([\d-]+)"/)
  return m ? m[1] : null
}

interface DdgImage {
  image: string
  thumbnail: string
  width?: number
  height?: number
  source?: string
}

async function searchDdgImages(query: string): Promise<DdgImage[]> {
  const vqd = await getVqd(query)
  if (!vqd) return []
  const url =
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}` +
    `&vqd=${vqd}&f=,,,,,&p=-1`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: 'https://duckduckgo.com/',
    },
  })
  if (!res.ok) return []
  const data = await res.json().catch(() => null)
  if (!data?.results) return []
  return data.results as DdgImage[]
}

/** Attempt to download a candidate image. Returns bytes + contentType on success. */
async function downloadImage(
  url: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (!ct.startsWith('image/')) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    // Skip tiny / huge
    if (buf.byteLength < 3000 || buf.byteLength > 5_000_000) return null
    return { bytes: buf, contentType: ct.split(';')[0].trim() }
  } catch {
    return null
  }
}

function extToMime(ct: string): string {
  if (ct.includes('png')) return 'png'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('gif')) return 'gif'
  return 'jpg'
}

async function seedOne(
  supabase: any,
  product: string
): Promise<{ product: string; ok: boolean; url?: string; error?: string }> {
  try {
    const query = `${product} bottle product`
    const candidates = await searchDdgImages(query)
    if (!candidates.length) return { product, ok: false, error: 'no_search_results' }

    // Try up to 5 candidates, prefer medium-sized images
    const ranked = candidates
      .filter((c) => c.image && /^https?:\/\//.test(c.image))
      .slice(0, 10)
      .sort((a, b) => {
        const score = (c: DdgImage) => {
          const w = c.width ?? 0
          const h = c.height ?? 0
          // Prefer 300-1200 px range
          const target = 600
          return -Math.abs((w || target) - target) - Math.abs((h || target) - target)
        }
        return score(b) - score(a)
      })

    for (const cand of ranked.slice(0, 5)) {
      const dl = await downloadImage(cand.image)
      if (!dl) continue
      const ext = extToMime(dl.contentType)
      const safe = product.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 60)
      const fileName = `${safe}_${Date.now()}.${ext}`

      const { error: upErr } = await supabase.storage
        .from('bottle-references')
        .upload(fileName, dl.bytes, {
          contentType: dl.contentType,
          upsert: false,
        })
      if (upErr) {
        // Fall back to next candidate on storage error
        continue
      }
      const { data: urlData } = supabase.storage
        .from('bottle-references')
        .getPublicUrl(fileName)
      const image_url = (urlData as any).publicUrl

      const { error: insErr } = await supabase
        .from('bottle_references')
        .insert({
          product_name: product,
          image_url,
          priority: 100,
          notes: `auto-seeded from ${cand.source ?? 'ddg'}`,
        })
      if (insErr) return { product, ok: false, error: `db: ${insErr.message}` }

      return { product, ok: true, url: image_url }
    }
    return { product, ok: false, error: 'no_viable_download' }
  } catch (e) {
    return { product, ok: false, error: String(e).slice(0, 200) }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  let payload: { products?: string[]; skip_existing?: boolean }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid json body' }, 400)
  }

  let products = Array.isArray(payload.products)
    ? payload.products.filter((p) => typeof p === 'string' && p.trim()).slice(0, 50)
    : []
  if (!products.length) return json({ error: 'products is required (array, max 50)' }, 400)

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  })

  // Skip products that already have at least one reference unless caller opts out
  if (payload.skip_existing !== false) {
    const { data: existing } = await supabase
      .from('bottle_references')
      .select('product_name')
      .in('product_name', products)
    const has = new Set((existing ?? []).map((r: any) => r.product_name))
    products = products.filter((p) => !has.has(p))
  }

  const results: Array<{ product: string; ok: boolean; url?: string; error?: string }> = []
  // Process sequentially to respect DDG rate limits + stay under function timeout
  for (const p of products) {
    const r = await seedOne(supabase, p)
    results.push(r)
    // Gentle pacing
    await new Promise((res) => setTimeout(res, 250))
  }

  const okCount = results.filter((r) => r.ok).length
  return json({
    results,
    summary: { requested: products.length, ok: okCount, failed: products.length - okCount },
  })
})
