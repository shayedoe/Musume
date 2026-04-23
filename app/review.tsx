import { useEffect, useMemo, useState } from 'react'
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
import type { BottleAnnotation, FillLevel } from '../lib/types'

interface ReviewRow {
  id: string
  detectionId?: string
  product: string
  count: string
  fill: FillLevel
  confidence?: number | null
  notes?: string | null
  isManual?: boolean
}

const FILL_OPTIONS: { label: string; value: FillLevel }[] = [
  { label: 'Full', value: 1 },
  { label: 'Half', value: 0.5 },
  { label: 'Low', value: 0.1 },
  { label: 'Empty', value: 0 },
]

function snapFill(value: unknown): FillLevel {
  const n = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(n)) return 1
  const buckets: FillLevel[] = [1, 0.5, 0.1, 0]
  let best: FillLevel = 1
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

export default function Review() {
  const router = useRouter()
  const { session_id } = useLocalSearchParams<{ session_id: string }>()
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [imageUrls, setImageUrls] = useState<string[]>([])
  const [annotationsByUrl, setAnnotationsByUrl] = useState<Record<string, BottleAnnotation[]>>({})
  const [rows, setRows] = useState<ReviewRow[]>([])

  useEffect(() => {
    loadSessionData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSessionData = async () => {
    try {
      const { data: photoData } = await (supabase as any)
        .from('photos')
        .select('image_url, annotations')
        .eq('session_id', session_id)
      const photos = ((photoData as any[]) ?? [])
      setImageUrls(photos.map((p) => p.image_url))
      const map: Record<string, BottleAnnotation[]> = {}
      for (const p of photos) {
        if (Array.isArray(p.annotations)) {
          map[p.image_url] = p.annotations as BottleAnnotation[]
        }
      }
      setAnnotationsByUrl(map)

      const { data: detData } = await (supabase as any)
        .from('detections')
        .select('*')
        .eq('session_id', session_id)

      const detectionRows: ReviewRow[] = ((detData as any[]) ?? []).map((d: any, i: number) => ({
        id: `d-${d.id ?? i}`,
        detectionId: d.id,
        product: d.predicted_product ?? '',
        count: String(d.count ?? 1),
        fill: snapFill(d.fill_level),
        confidence: d.confidence,
        notes: d.notes,
      }))

      if (detectionRows.length === 0) {
        setRows([{ id: 'm-1', product: '', count: '1', fill: 1, isManual: true }])
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
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  const removeRow = (id: string) => {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev))
  }
  const addManualRow = () => {
    setRows((prev) => [
      ...prev,
      { id: `m-${Date.now()}`, product: '', count: '1', fill: 1, isManual: true },
    ])
  }

  const finals = useMemo(() => {
    const bucket = new Map<string, { product: string; quantity: number }>()
    for (const r of rows) {
      const name = r.product.trim()
      if (!name) continue
      const c = parseFloat(r.count)
      if (!Number.isFinite(c) || c <= 0) continue
      const qty = c * r.fill
      const key = name.toLowerCase()
      const existing = bucket.get(key)
      if (existing) existing.quantity += qty
      else bucket.set(key, { product: name, quantity: qty })
    }
    return Array.from(bucket.values()).map((b) => ({
      ...b,
      quantity: Math.round(b.quantity * 100) / 100,
    }))
  }, [rows])

  const saveCounts = async () => {
    try {
      if (finals.length === 0) return Alert.alert('No data', 'Add at least one product with a count.')
      await (supabase as any).from('final_counts').delete().eq('session_id', session_id)
      const { error } = await (supabase as any)
        .from('final_counts')
        .insert(finals.map((f) => ({ session_id, ...f })) as any)
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
      const header = 'Product,Count,Unit\n'
      const body = finals
        .map((f) => `"${f.product.replace(/"/g, '""')}",${f.quantity},bottle`)
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
            {finals.length === 1 ? '' : 's'} · final qty = count × fill
          </Text>
        </View>

        {imageUrls.length > 0 && (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginTop: 16 }}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
            >
              {imageUrls.map((url) => (
                <AnnotatedPhoto
                  key={url}
                  url={url}
                  annotations={annotationsByUrl[url] ?? []}
                />
              ))}
            </ScrollView>
            {Object.values(annotationsByUrl).some((a) => a.length > 0) && (
              <View
                style={{
                  flexDirection: 'row',
                  paddingHorizontal: 20,
                  marginTop: 10,
                  gap: 14,
                  flexWrap: 'wrap',
                }}
              >
                <LegendDot color="#22c55e" label="Matched reference" />
                <LegendDot color="#eab308" label="Identified" />
                <LegendDot color="#ef4444" label="Unknown" />
              </View>
            )}
          </>
        )}

        {/* Compact table: product · count · fill · remove */}
        <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
          <View
            style={{
              flexDirection: 'row',
              paddingHorizontal: 12,
              paddingBottom: 6,
            }}
          >
            <Text style={{ flex: 1, fontSize: 11, color: theme.textFaint, letterSpacing: 0.6, textTransform: 'uppercase' }}>
              Product
            </Text>
            <Text style={{ width: 48, fontSize: 11, color: theme.textFaint, letterSpacing: 0.6, textTransform: 'uppercase', textAlign: 'center' }}>
              Qty
            </Text>
            <Text style={{ width: 56, fontSize: 11, color: theme.textFaint, letterSpacing: 0.6, textTransform: 'uppercase', textAlign: 'right' }}>
              Final
            </Text>
          </View>

          {rows.map((r) => {
            const finalQty = ((parseFloat(r.count) || 0) * r.fill).toFixed(2)
            return (
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
                  <TextInput
                    value={r.count}
                    onChangeText={(text) => updateRow(r.id, { count: text })}
                    keyboardType="number-pad"
                    style={{
                      width: 48,
                      backgroundColor: theme.surfaceAlt,
                      color: theme.text,
                      borderRadius: 6,
                      paddingVertical: 6,
                      paddingHorizontal: 6,
                      fontSize: 14,
                      textAlign: 'center',
                    }}
                  />
                  <Text
                    style={{
                      width: 56,
                      color: theme.textMuted,
                      fontSize: 13,
                      textAlign: 'right',
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    {finalQty}
                  </Text>
                </View>

                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: 10,
                    gap: 6,
                  }}
                >
                  {FILL_OPTIONS.map((opt) => {
                    const selected = r.fill === opt.value
                    return (
                      <Pressable
                        key={opt.value}
                        onPress={() => updateRow(r.id, { fill: opt.value })}
                        style={({ pressed }) => ({
                          paddingVertical: 5,
                          paddingHorizontal: 10,
                          borderRadius: 14,
                          backgroundColor: selected
                            ? theme.accent
                            : pressed
                              ? '#2a2a2f'
                              : theme.surfaceAlt,
                        })}
                      >
                        <Text
                          style={{
                            color: selected ? theme.accentText : theme.textMuted,
                            fontSize: 11,
                            fontWeight: '600',
                            letterSpacing: 0.2,
                          }}
                        >
                          {opt.label}
                        </Text>
                      </Pressable>
                    )
                  })}
                  <View style={{ flex: 1 }} />
                  {rows.length > 1 && (
                    <Pressable onPress={() => removeRow(r.id)} hitSlop={8}>
                      <Text style={{ color: theme.danger, fontSize: 11, fontWeight: '600' }}>
                        REMOVE
                      </Text>
                    </Pressable>
                  )}
                </View>

                {(r.confidence != null || r.isManual) && (
                  <Text
                    style={{
                      color: theme.textFaint,
                      fontSize: 10,
                      marginTop: 6,
                      letterSpacing: 0.4,
                      textTransform: 'uppercase',
                    }}
                  >
                    {r.isManual
                      ? 'Manual'
                      : r.confidence != null
                        ? `Conf ${(r.confidence * 100).toFixed(0)}%`
                        : ''}
                  </Text>
                )}
              </View>
            )
          })}

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

        {/* Final counts summary */}
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
            Export preview · {finals.length} product{finals.length === 1 ? '' : 's'}
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
                }}
              >
                {f.quantity}
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
  matched: '#22c55e', // green
  identified: '#eab308', // yellow
  unknown: '#ef4444', // red
}

function AnnotatedPhoto({
  url,
  annotations,
}: {
  url: string
  annotations: BottleAnnotation[]
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  // Preview size — tall enough to see bottles clearly, still fits in horizontal strip.
  const W = 220
  const H = 300

  return (
    <View
      style={{
        width: W,
        height: H,
        borderRadius: 10,
        backgroundColor: theme.surface,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <Image
        source={{ uri: url }}
        style={{ width: W, height: H }}
        resizeMode="cover"
        onLoad={(e) => {
          const src = e.nativeEvent?.source
          if (src && typeof src.width === 'number' && typeof src.height === 'number') {
            setDims({ w: src.width, h: src.height })
          }
        }}
      />
      {annotations.length > 0 &&
        annotations.map((a, i) => {
          // bbox is normalized [0,1] relative to the ORIGINAL image.
          // With resizeMode="cover", the image is scaled so min dim fills
          // and the other dim is cropped. Compute the visible rect.
          let scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0
          if (dims) {
            const scale = Math.max(W / dims.w, H / dims.h)
            const displayW = dims.w * scale
            const displayH = dims.h * scale
            offsetX = (W - displayW) / 2
            offsetY = (H - displayH) / 2
            scaleX = displayW
            scaleY = displayH
          } else {
            // Fallback: assume no crop (1:1 mapping)
            scaleX = W
            scaleY = H
          }
          const [bx, by, bw, bh] = a.bbox
          const left = offsetX + bx * scaleX
          const top = offsetY + by * scaleY
          const width = bw * scaleX
          const height = bh * scaleY
          const color = STATUS_COLORS[a.status] ?? STATUS_COLORS.unknown
          return (
            <View
              key={i}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left,
                top,
                width,
                height,
                borderColor: color,
                borderWidth: 1.5,
                borderRadius: 2,
              }}
            />
          )
        })}
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
            {annotations.length} {annotations.length === 1 ? 'bottle' : 'bottles'}
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
