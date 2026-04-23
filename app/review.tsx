import { useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, Alert, ScrollView, Image, ActivityIndicator } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import * as Sharing from 'expo-sharing'
import { File, Paths } from 'expo-file-system'
import { supabase } from '../lib/supabase'
import type { FillLevel } from '../lib/types'

interface ReviewRow {
  id: string
  detectionId?: string
  product: string
  count: string   // number of bottles at this fill level
  fill: FillLevel
  confidence?: number | null
  notes?: string | null
  isManual?: boolean
}

const FILL_OPTIONS: { label: string; value: FillLevel }[] = [
  { label: 'Full (1)', value: 1 },
  { label: 'Half (0.5)', value: 0.5 },
  { label: 'Low (0.1)', value: 0.1 },
  { label: 'Empty (0)', value: 0 },
]

export default function Review() {
  const router = useRouter()
  const { session_id } = useLocalSearchParams<{ session_id: string }>()
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [imageUrls, setImageUrls] = useState<string[]>([])
  const [rows, setRows] = useState<ReviewRow[]>([])

  useEffect(() => {
    loadSessionData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSessionData = async () => {
    try {
      const { data: photoData } = await (supabase as any)
        .from('photos')
        .select('image_url')
        .eq('session_id', session_id)
      setImageUrls(((photoData as any[]) ?? []).map((p) => p.image_url))

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

  /**
   * Each row = N bottles at one fill level. Final qty = count × fill,
   * aggregated per product.
   */
  const buildFinalCounts = () => {
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
  }

  const saveCounts = async () => {
    try {
      const finals = buildFinalCounts()
      if (finals.length === 0) {
        Alert.alert('No data', 'Add at least one product with a count.')
        return
      }
      await (supabase as any).from('final_counts').delete().eq('session_id', session_id)
      const { error } = await (supabase as any)
        .from('final_counts')
        .insert(finals.map((f) => ({ session_id, ...f })) as any)
      if (error) throw error
      Alert.alert('Saved', `Saved ${finals.length} product line${finals.length > 1 ? 's' : ''}.`)
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to save counts')
    }
  }

  const exportToCSV = async () => {
    setExporting(true)
    try {
      const finals = buildFinalCounts()
      if (finals.length === 0) {
        Alert.alert('No data', 'Add at least one product with a count.')
        return
      }
      const header = 'Product,Count,Unit\n'
      const body = finals
        .map((f) => `"${f.product.replace(/"/g, '""')}",${f.quantity},bottle`)
        .join('\n')
      const csv = header + body
      const fileName = `inventory_${session_id}_${Date.now()}.csv`
      const file = new File(Paths.document, fileName)
      file.write(csv)
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: 'Export Inventory CSV' })
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
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    )
  }

  const finals = buildFinalCounts()

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ padding: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: '700', marginBottom: 12 }}>Review & Count</Text>

        {imageUrls.length > 0 && (
          <ScrollView horizontal style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {imageUrls.map((url) => (
                <Image
                  key={url}
                  source={{ uri: url }}
                  style={{ width: 140, height: 180, borderRadius: 8 }}
                  resizeMode="cover"
                />
              ))}
            </View>
          </ScrollView>
        )}

        <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 8 }}>
          AI Detections ({rows.filter((r) => !r.isManual).length}) + Manual ({rows.filter((r) => r.isManual).length})
        </Text>
        <Text style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          Each row = N bottles at one fill level. Final qty = count × fill.
        </Text>

        {rows.map((r) => (
          <View
            key={r.id}
            style={{
              padding: 12,
              backgroundColor: r.isManual ? '#fff8e1' : '#f5f5f5',
              borderRadius: 8,
              marginBottom: 10,
              borderWidth: 1,
              borderColor: r.isManual ? '#ffe0a3' : '#eee',
            }}
          >
            <TextInput
              placeholder="Product name"
              value={r.product}
              onChangeText={(text) => updateRow(r.id, { product: text })}
              style={{
                padding: 10, backgroundColor: '#fff', borderRadius: 6,
                marginBottom: 8, fontSize: 15,
              }}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <Text style={{ fontSize: 13, color: '#666' }}>Bottles:</Text>
              <TextInput
                placeholder="#"
                value={r.count}
                onChangeText={(text) => updateRow(r.id, { count: text })}
                keyboardType="number-pad"
                style={{
                  width: 70, padding: 10, backgroundColor: '#fff',
                  borderRadius: 6, fontSize: 15, textAlign: 'center',
                }}
              />
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
              {FILL_OPTIONS.map((opt) => {
                const selected = r.fill === opt.value
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => updateRow(r.id, { fill: opt.value })}
                    style={{
                      paddingVertical: 6, paddingHorizontal: 10,
                      borderRadius: 16,
                      backgroundColor: selected ? '#007AFF' : '#e7e7ea',
                    }}
                  >
                    <Text style={{ color: selected ? '#fff' : '#333', fontSize: 13 }}>{opt.label}</Text>
                  </Pressable>
                )
              })}
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 12, color: '#666' }}>
                {r.confidence != null ? `AI conf: ${(r.confidence * 100).toFixed(0)}%` : r.isManual ? 'Manual' : 'AI'}
                {'  •  '}
                qty = {((parseFloat(r.count) || 0) * r.fill).toFixed(2)}
              </Text>
              {rows.length > 1 && (
                <Pressable onPress={() => removeRow(r.id)}>
                  <Text style={{ color: '#ff3b30', fontSize: 13 }}>Remove</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))}

        <Pressable
          onPress={addManualRow}
          style={{
            padding: 14, backgroundColor: '#e0e0e0', borderRadius: 8,
            alignItems: 'center', marginBottom: 20,
          }}
        >
          <Text style={{ fontSize: 15, color: '#333' }}>+ Add Missed Bottle</Text>
        </Pressable>

        <View style={{ padding: 12, backgroundColor: '#f0f7ff', borderRadius: 8, marginBottom: 20 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', marginBottom: 6 }}>
            Export Preview ({finals.length} product{finals.length === 1 ? '' : 's'})
          </Text>
          {finals.slice(0, 8).map((f, i) => (
            <Text key={i} style={{ fontSize: 12, color: '#333' }}>
              {f.product} — {f.quantity} bottle{f.quantity === 1 ? '' : 's'}
            </Text>
          ))}
          {finals.length > 8 && (
            <Text style={{ fontSize: 12, color: '#666' }}>…and {finals.length - 8} more</Text>
          )}
        </View>

        <View style={{ gap: 10 }}>
          <Pressable
            onPress={saveCounts}
            style={{ padding: 15, backgroundColor: '#34C759', borderRadius: 8, alignItems: 'center' }}
          >
            <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Save Counts</Text>
          </Pressable>
          <Pressable
            onPress={exportToCSV}
            disabled={exporting}
            style={{
              padding: 15, backgroundColor: exporting ? '#ccc' : '#007AFF',
              borderRadius: 8, alignItems: 'center',
            }}
          >
            {exporting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Export CSV</Text>
            )}
          </Pressable>
          <Pressable
            onPress={() => router.push('/')}
            style={{ padding: 15, backgroundColor: '#666', borderRadius: 8, alignItems: 'center' }}
          >
            <Text style={{ color: '#fff', fontSize: 16 }}>Back to Home</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  )
}

function snapFill(v: any): FillLevel {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  const buckets: FillLevel[] = [1, 0.5, 0.1, 0]
  if (!Number.isFinite(n)) return 1
  let best: FillLevel = 1
  let bd = Infinity
  for (const b of buckets) {
    const d = Math.abs(n - b)
    if (d < bd) {
      bd = d
      best = b
    }
  }
  return best
}
