import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  Alert,
  ScrollView,
  Image,
  ActivityIndicator,
  StatusBar,
} from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import * as Sharing from 'expo-sharing'
import { File, Paths } from 'expo-file-system'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'
import type { BottleAnnotation } from '../lib/types'

interface ReviewRow {
  id: string
  detectionId?: string
  product: string
  count: string
  confidence?: number | null
  notes?: string | null
  isManual?: boolean
  unitPrice?: number | null
  thumbUrl?: string | null
}

export default function Review() {
  const router = useRouter()
  const { session_id } = useLocalSearchParams<{ session_id: string }>()
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [photos, setPhotos] = useState<{ url: string; annotations: BottleAnnotation[] }[]>([])
  const [rows, setRows] = useState<ReviewRow[]>([])
  // product-name (lowercase) -> { unit_price, thumb_url }
  const [productMeta, setProductMeta] = useState<
    Record<string, { price: number | null; thumb: string | null }>
  >({})

  useEffect(() => {
    loadSessionData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSessionData = async () => {
    try {
      // Photos with annotations. Fall back if the column doesn't exist yet.
      let photoRows: any[] = []
      {
        const { data, error } = await (supabase as any)
          .from('photos')
          .select('image_url, annotations')
          .eq('session_id', session_id)
        if (error) {
          const fallback = await (supabase as any)
            .from('photos')
            .select('image_url')
            .eq('session_id', session_id)
          photoRows = (fallback.data as any[]) ?? []
        } else {
          photoRows = (data as any[]) ?? []
        }
      }
      const loadedPhotos = photoRows.map((p) => ({
        url: p.image_url as string,
        annotations: Array.isArray(p.annotations) ? (p.annotations as BottleAnnotation[]) : [],
      }))
      setPhotos(loadedPhotos)

      const { data: detData } = await (supabase as any)
        .from('detections')
        .select('*')
        .eq('session_id', session_id)

      // Pull product prices + reference thumbnails for the bottles we need.
      const productNames = new Set<string>(
        ((detData as any[]) ?? [])
          .map((d: any) => String(d.predicted_product ?? '').toLowerCase().trim())
          .filter(Boolean)
      )
      const meta: Record<string, { price: number | null; thumb: string | null }> = {}

      if (productNames.size > 0) {
        // Prices from `products` table. unit_price may not exist in older DBs.
        let priceRows: any[] = []
        try {
          const res = await (supabase as any)
            .from('products')
            .select('name, unit_price')
          priceRows = (res.data as any[]) ?? []
        } catch {
          priceRows = []
        }
        for (const p of priceRows) {
          const key = String(p.name ?? '').toLowerCase().trim()
          if (!key) continue
          meta[key] = {
            price: p.unit_price != null ? Number(p.unit_price) : null,
            thumb: null,
          }
        }
        // Reference photos — best single thumbnail per product_name.
        try {
          const res = await (supabase as any)
            .from('bottle_references')
            .select('product_name, image_url, priority')
            .order('priority', { ascending: true })
          const refs = (res.data as any[]) ?? []
          for (const r of refs) {
            const key = String(r.product_name ?? '').toLowerCase().trim()
            if (!key) continue
            if (!meta[key]) meta[key] = { price: null, thumb: null }
            if (!meta[key].thumb) meta[key].thumb = r.image_url ?? null
          }
        } catch {
          /* non-fatal */
        }
      }
      setProductMeta(meta)

      const detectionRows: ReviewRow[] = ((detData as any[]) ?? []).map(
        (d: any, i: number) => {
          const pname = String(d.predicted_product ?? '')
          const key = pname.toLowerCase().trim()
          return {
            id: `d-${d.id ?? i}`,
            detectionId: d.id,
            product: pname,
            count: String(d.count ?? 1),
            confidence: d.confidence,
            notes: d.notes,
            unitPrice: meta[key]?.price ?? null,
            thumbUrl: meta[key]?.thumb ?? null,
          }
        }
      )

      if (detectionRows.length === 0) {
        setRows([{ id: 'm-1', product: '', count: '1', isManual: true }])
      } else {
        setRows(detectionRows)
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to load session data')
    } finally {
      setLoading(false)
    }
  }

  const updateRow = (id: string, patch: Partial<ReviewRow>) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r
        const next = { ...r, ...patch }
        // Refresh thumb/price if product name changed
        if (patch.product !== undefined) {
          const key = (patch.product as string).toLowerCase().trim()
          const m = productMeta[key]
          next.unitPrice = m?.price ?? null
          next.thumbUrl = m?.thumb ?? null
        }
        return next
      })
    )
  }

  const bumpCount = (id: string, delta: number) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r
        const n = parseInt(r.count, 10)
        const base = Number.isFinite(n) ? n : 0
        const next = Math.max(0, base + delta)
        return { ...r, count: String(next) }
      })
    )
  }

  const removeRow = (id: string) => {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev))
  }
  const addManualRow = () => {
    setRows((prev) => [
      ...prev,
      { id: `m-${Date.now()}`, product: '', count: '1', isManual: true },
    ])
  }

  const finals = useMemo(() => {
    // Full-only: quantity = integer count
    const bucket = new Map<
      string,
      { product: string; quantity: number; totalValue: number; hasPrice: boolean }
    >()
    for (const r of rows) {
      const name = r.product.trim()
      if (!name) continue
      const c = parseInt(r.count, 10)
      if (!Number.isFinite(c) || c <= 0) continue
      const key = name.toLowerCase()
      const price = r.unitPrice ?? null
      const existing = bucket.get(key)
      if (existing) {
        existing.quantity += c
        if (price != null) {
          existing.totalValue += c * price
          existing.hasPrice = true
        }
      } else {
        bucket.set(key, {
          product: name,
          quantity: c,
          totalValue: price != null ? c * price : 0,
          hasPrice: price != null,
        })
      }
    }
    return Array.from(bucket.values())
  }, [rows])

  const grandTotal = useMemo(() => {
    let sum = 0
    let partial = false
    for (const f of finals) {
      if (f.hasPrice) sum += f.totalValue
      else if (f.quantity > 0) partial = true
    }
    return { sum: Math.round(sum * 100) / 100, partial }
  }, [finals])

  const saveCounts = async () => {
    try {
      if (finals.length === 0) return Alert.alert('No data', 'Add at least one product with a count.')
      await (supabase as any).from('final_counts').delete().eq('session_id', session_id)
      const { error } = await (supabase as any)
        .from('final_counts')
        .insert(
          finals.map((f) => ({
            session_id,
            product: f.product,
            quantity: f.quantity,
          })) as any
        )
      if (error) throw error
      Alert.alert('Saved', `${finals.length} line${finals.length > 1 ? 's' : ''} saved.`)
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to save counts')
    }
  }

  const exportToCSV = async () => {
    setExporting(true)
    try {
      if (finals.length === 0) return Alert.alert('No data', 'Nothing to export.')
      const header = 'Product,Count,Unit,Value\n'
      const body = finals
        .map((f) => {
          const val = f.hasPrice ? f.totalValue.toFixed(2) : ''
          return `"${f.product.replace(/"/g, '""')}",${f.quantity},bottle,${val}`
        })
        .join('\n')
      const csv = header + body
      const fileName = `inventory_${session_id}_${Date.now()}.csv`
      const file = new File(Paths.document, fileName)
      file.write(csv)
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'text/csv',
          dialogTitle: 'Export Inventory CSV',
        })
      } else {
        Alert.alert('Saved', `CSV saved to ${file.uri}`)
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to export CSV')
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.bg }}>
        <ActivityIndicator size="large" color={theme.text} />
      </View>
    )
  }

  const hasAnyBoxes = photos.some((p) => p.annotations.length > 0)

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingTop: 56, paddingHorizontal: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
            <Pressable onPress={() => router.back()} hitSlop={10}>
              <Text style={{ color: theme.textMuted, fontSize: 15 }}>‹  Back</Text>
            </Pressable>
          </View>
          <Text style={{ color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: 0.2 }}>
            Review
          </Text>
          <Text style={{ color: theme.textMuted, fontSize: 13, marginTop: 4 }}>
            {rows.length} line{rows.length === 1 ? '' : 's'} · {finals.length} product
            {finals.length === 1 ? '' : 's'}
          </Text>
        </View>

        {photos.length > 0 && (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginTop: 16 }}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
            >
              {photos.map((p, i) => (
                <AnnotatedPhoto key={`${p.url}-${i}`} url={p.url} annotations={p.annotations} />
              ))}
            </ScrollView>
            {hasAnyBoxes && (
              <View
                style={{
                  flexDirection: 'row',
                  paddingHorizontal: 20,
                  marginTop: 10,
                  gap: 14,
                  flexWrap: 'wrap',
                }}
              >
                <LegendDot color="#22c55e" label="Matched" />
                <LegendDot color="#eab308" label="Identified" />
                <LegendDot color="#ef4444" label="Unknown" />
              </View>
            )}
          </>
        )}

        {/* Rows */}
        <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
          {rows.map((r) => (
            <View
              key={r.id}
              style={{
                backgroundColor: theme.surface,
                borderRadius: 12,
                padding: 12,
                marginBottom: 8,
                borderWidth: 1,
                borderColor: r.isManual ? '#3a3a40' : theme.border,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {/* Bottle thumbnail */}
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 6,
                    backgroundColor: theme.surfaceAlt,
                    marginRight: 10,
                    overflow: 'hidden',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {r.thumbUrl ? (
                    <Image
                      source={{ uri: r.thumbUrl }}
                      style={{ width: 40, height: 40 }}
                      resizeMode="cover"
                    />
                  ) : (
                    <Text style={{ color: theme.textFaint, fontSize: 10 }}>—</Text>
                  )}
                </View>

                <TextInput
                  placeholder="Product"
                  placeholderTextColor={theme.textFaint}
                  value={r.product}
                  onChangeText={(text) => updateRow(r.id, { product: text })}
                  style={{
                    flex: 1,
                    color: theme.text,
                    fontSize: 14,
                    paddingVertical: 4,
                  }}
                />
              </View>

              {/* Count controls */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginTop: 10,
                  gap: 8,
                }}
              >
                <Pressable
                  onPress={() => bumpCount(r.id, -1)}
                  style={({ pressed }) => ({
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    backgroundColor: pressed ? '#2a2a2f' : theme.surfaceAlt,
                    alignItems: 'center',
                    justifyContent: 'center',
                  })}
                  hitSlop={6}
                >
                  <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>−</Text>
                </Pressable>
                <TextInput
                  value={r.count}
                  onChangeText={(text) => updateRow(r.id, { count: text })}
                  keyboardType="number-pad"
                  style={{
                    width: 56,
                    backgroundColor: theme.surfaceAlt,
                    color: theme.text,
                    borderRadius: 6,
                    paddingVertical: 6,
                    paddingHorizontal: 6,
                    fontSize: 15,
                    textAlign: 'center',
                    fontWeight: '600',
                  }}
                />
                <Pressable
                  onPress={() => bumpCount(r.id, 1)}
                  style={({ pressed }) => ({
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    backgroundColor: pressed ? '#2a2a2f' : theme.surfaceAlt,
                    alignItems: 'center',
                    justifyContent: 'center',
                  })}
                  hitSlop={6}
                >
                  <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>+</Text>
                </Pressable>
                <View style={{ flex: 1 }} />
                {r.unitPrice != null && (
                  <Text
                    style={{
                      color: theme.textMuted,
                      fontSize: 12,
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    ${(r.unitPrice * (parseInt(r.count, 10) || 0)).toFixed(2)}
                  </Text>
                )}
                {rows.length > 1 && (
                  <Pressable onPress={() => removeRow(r.id)} hitSlop={8}>
                    <Text style={{ color: theme.danger, fontSize: 11, fontWeight: '600' }}>
                      REMOVE
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>
          ))}

          <Pressable
            onPress={addManualRow}
            style={({ pressed }) => ({
              paddingVertical: 12,
              borderRadius: 10,
              alignItems: 'center',
              backgroundColor: pressed ? '#26262a' : theme.surface,
              borderWidth: 1,
              borderColor: theme.border,
              marginBottom: 20,
            })}
          >
            <Text style={{ color: theme.textMuted, fontSize: 13, fontWeight: '500' }}>
              + Add row
            </Text>
          </Pressable>
        </View>

        {/* Summary */}
        <View
          style={{
            marginHorizontal: 20,
            marginBottom: 20,
            backgroundColor: theme.surface,
            borderRadius: 12,
            padding: 14,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <Text
            style={{
              color: theme.textFaint,
              fontSize: 11,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Summary · {finals.length} product{finals.length === 1 ? '' : 's'}
          </Text>
          {finals.slice(0, 10).map((f, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                paddingVertical: 6,
                borderTopWidth: i === 0 ? 0 : 1,
                borderColor: theme.border,
              }}
            >
              <Text style={{ flex: 1, color: theme.text, fontSize: 13 }} numberOfLines={1}>
                {f.product}
              </Text>
              <Text
                style={{
                  color: theme.text,
                  fontSize: 13,
                  fontVariant: ['tabular-nums'],
                  fontWeight: '600',
                  width: 40,
                  textAlign: 'right',
                }}
              >
                {f.quantity}
              </Text>
              <Text
                style={{
                  color: f.hasPrice ? theme.text : theme.textFaint,
                  fontSize: 13,
                  fontVariant: ['tabular-nums'],
                  width: 70,
                  textAlign: 'right',
                }}
              >
                {f.hasPrice ? `$${f.totalValue.toFixed(2)}` : '—'}
              </Text>
            </View>
          ))}
          {finals.length > 10 && (
            <Text style={{ color: theme.textFaint, fontSize: 12, marginTop: 6 }}>
              …and {finals.length - 10} more
            </Text>
          )}
          {finals.length === 0 && (
            <Text style={{ color: theme.textFaint, fontSize: 12, fontStyle: 'italic' }}>
              No rows yet.
            </Text>
          )}

          {finals.length > 0 && (
            <View
              style={{
                flexDirection: 'row',
                paddingTop: 10,
                marginTop: 6,
                borderTopWidth: 1,
                borderColor: theme.border,
              }}
            >
              <Text style={{ flex: 1, color: theme.text, fontSize: 14, fontWeight: '700' }}>
                Total Value{grandTotal.partial ? ' (partial)' : ''}
              </Text>
              <Text
                style={{
                  color: theme.text,
                  fontSize: 14,
                  fontWeight: '700',
                  fontVariant: ['tabular-nums'],
                }}
              >
                ${grandTotal.sum.toFixed(2)}
              </Text>
            </View>
          )}
          {grandTotal.partial && (
            <Text style={{ color: theme.textFaint, fontSize: 11, marginTop: 4 }}>
              Some products don't have a unit price yet.
            </Text>
          )}
        </View>

        <View style={{ paddingHorizontal: 20, gap: 10 }}>
          <Pressable
            onPress={saveCounts}
            style={({ pressed }) => ({
              padding: 16,
              backgroundColor: pressed ? '#26262a' : theme.surfaceAlt,
              borderRadius: 12,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: theme.border,
            })}
          >
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>Save</Text>
          </Pressable>
          <Pressable
            onPress={exportToCSV}
            disabled={exporting}
            style={({ pressed }) => ({
              padding: 16,
              backgroundColor: exporting
                ? theme.surfaceAlt
                : pressed
                  ? '#e7e7e9'
                  : theme.accent,
              borderRadius: 12,
              alignItems: 'center',
            })}
          >
            {exporting ? (
              <ActivityIndicator color={theme.text} />
            ) : (
              <Text style={{ color: theme.accentText, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 }}>
                Export CSV
              </Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </View>
  )
}

// ---------- Annotated photo overlay ----------

const STATUS_COLORS: Record<BottleAnnotation['status'], string> = {
  matched: '#22c55e',
  identified: '#eab308',
  unknown: '#ef4444',
}

function AnnotatedPhoto({
  url,
  annotations,
}: {
  url: string
  annotations: BottleAnnotation[]
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string>(url)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [showOverlay, setShowOverlay] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retried, setRetried] = useState(false)
  const W = 300
  const H = 400

  // If the public URL fails (private bucket), fall back to a 1-hour signed URL.
  const trySignedUrl = useCallback(async (): Promise<string | null> => {
    try {
      // public URL shape: <base>/storage/v1/object/public/<bucket>/<path>
      const m = url.match(/\/object\/public\/([^/]+)\/(.+)$/)
      if (!m) return null
      const [, bucket, path] = m
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(decodeURIComponent(path), 3600)
      if (error || !data?.signedUrl) return null
      return data.signedUrl
    } catch {
      return null
    }
  }, [url])

  // Eagerly fetch the image dimensions so the overlay aligns even if
  // <Image onLoad> doesn't surface them on this platform.
  useEffect(() => {
    let cancelled = false
    Image.getSize(
      resolvedUrl,
      (w, h) => {
        if (!cancelled) {
          setDims({ w, h })
          setLoadError(null)
        }
      },
      async (err) => {
        if (cancelled) return
        // Auto-retry once with a signed URL in case the bucket is private.
        if (!retried) {
          setRetried(true)
          const signed = await trySignedUrl()
          if (signed && !cancelled) {
            setResolvedUrl(signed)
            return
          }
        }
        const msg = typeof err === 'string' ? err : (err as any)?.message ?? 'image failed to load'
        setLoadError(String(msg))
      }
    )
    return () => {
      cancelled = true
    }
  }, [resolvedUrl, retried, trySignedUrl])

  // Compute the visible rect of the image. We use `contain` so the full
  // photo is always visible (no cropping), then letterbox the remainder.
  let scaleX = W, scaleY = H, offsetX = 0, offsetY = 0
  if (dims) {
    const scale = Math.min(W / dims.w, H / dims.h)
    const displayW = dims.w * scale
    const displayH = dims.h * scale
    offsetX = (W - displayW) / 2
    offsetY = (H - displayH) / 2
    scaleX = displayW
    scaleY = displayH
  }

  return (
    <View
      style={{
        width: W,
        height: H,
        borderRadius: 10,
        backgroundColor: '#000',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <Image
        source={{ uri: resolvedUrl }}
        style={{ width: W, height: H }}
        resizeMode="contain"
        onLoad={(e) => {
          const src: any = e.nativeEvent?.source
          if (src && typeof src.width === 'number' && typeof src.height === 'number') {
            setDims({ w: src.width, h: src.height })
          }
        }}
        onError={async (e) => {
          // Same private-bucket fallback as Image.getSize.
          if (!retried) {
            setRetried(true)
            const signed = await trySignedUrl()
            if (signed) {
              setResolvedUrl(signed)
              return
            }
          }
          setLoadError(String(e?.nativeEvent?.error ?? 'image failed to load'))
        }}
      />
      {showOverlay &&
        annotations.map((a, i) => {
          const [bx, by, bw, bh] = a.bbox
          const left = offsetX + bx * scaleX
          const top = offsetY + by * scaleY
          const width = bw * scaleX
          const height = bh * scaleY
          const color = STATUS_COLORS[a.status] ?? STATUS_COLORS.unknown
          // Filled translucent bottle-shaped mask: a rounded neck on top
          // plus a body. Opacity is intentionally low so the underlying
          // photo stays visible even when many bottles overlap.
          const neckH = Math.max(6, height * 0.22)
          const neckW = Math.max(4, width * 0.38)
          const neckX = left + (width - neckW) / 2
          const bodyTop = top + neckH * 0.75
          const bodyH = height - neckH * 0.75
          return (
            <View key={i} pointerEvents="none">
              {/* Neck */}
              <View
                style={{
                  position: 'absolute',
                  left: neckX,
                  top,
                  width: neckW,
                  height: neckH,
                  backgroundColor: color,
                  opacity: 0.18,
                  borderTopLeftRadius: 3,
                  borderTopRightRadius: 3,
                  borderWidth: 1,
                  borderColor: color,
                }}
              />
              {/* Body */}
              <View
                style={{
                  position: 'absolute',
                  left,
                  top: bodyTop,
                  width,
                  height: bodyH,
                  backgroundColor: color,
                  opacity: 0.18,
                  borderRadius: Math.min(width, bodyH) * 0.18,
                  borderWidth: 1.5,
                  borderColor: color,
                }}
              />
            </View>
          )
        })}
      {/* Tap to toggle overlay so you can confirm the photo loaded. */}
      <Pressable
        onPress={() => setShowOverlay((v) => !v)}
        style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
      />
      {loadError && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.75)',
            padding: 6,
          }}
        >
          <Text style={{ color: '#fca5a5', fontSize: 10 }} numberOfLines={2}>
            {loadError}
          </Text>
        </View>
      )}
      {annotations.length > 0 && (
        <View
          style={{
            position: 'absolute',
            right: 4,
            top: 4,
            backgroundColor: 'rgba(0,0,0,0.6)',
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>
            {showOverlay ? `${annotations.length} ${annotations.length === 1 ? 'bottle' : 'bottles'}` : 'tap to show'}
          </Text>
        </View>
      )}
    </View>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 2,
          borderWidth: 1.5,
          borderColor: color,
        }}
      />
      <Text style={{ color: theme.textMuted, fontSize: 11 }}>{label}</Text>
    </View>
  )
}
