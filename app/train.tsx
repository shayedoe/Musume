import { useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  Alert,
  ActivityIndicator,
  Image,
  ScrollView,
  StatusBar,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { supabase } from '../lib/supabase'
import { ensureCatalogSeeded } from '../lib/catalog'
import { theme } from '../lib/theme'
import type { Product } from '../lib/types'

type TrainSlot = 'front' | 'back' | 'barcode'
type TrainMode = 'reference' | 'shelf'

interface LocalShot {
  uri: string
  base64: string
  width: number
  height: number
}

interface ShelfAnnotation {
  id: string
  bbox: [number, number, number, number]
  product: string
  notes?: string
}

interface Point {
  x: number
  y: number
}

const SLOTS: Array<{ key: TrainSlot; label: string; hint: string; priority: number }> = [
  {
    key: 'front',
    label: 'Front label',
    hint: 'Center the main label and keep the full bottle in frame.',
    priority: 10,
  },
  {
    key: 'back',
    label: 'Back label',
    hint: 'Capture the back label or neck label if it has useful text.',
    priority: 20,
  },
  {
    key: 'barcode',
    label: 'Barcode',
    hint: 'Fill the frame with the barcode and any nearby product text.',
    priority: 30,
  },
]

async function toJpegSmall(uri: string, width = 900): Promise<LocalShot> {
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width } }], {
    compress: 0.82,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  })
  return {
    uri: result.uri,
    base64: result.base64 ?? '',
    width: result.width,
    height: result.height,
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lookup = new Uint8Array(256)
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i
  const clean = b64.replace(/^data:.*?;base64,/, '').replace(/\s+/g, '')
  let padding = 0
  if (clean.endsWith('=')) padding++
  if (clean.endsWith('==')) padding++
  const byteLen = (clean.length * 3) / 4 - padding
  const bytes = new Uint8Array(byteLen)
  let p = 0
  for (let i = 0; i < clean.length; i += 4) {
    const e1 = lookup[clean.charCodeAt(i)]
    const e2 = lookup[clean.charCodeAt(i + 1)]
    const e3 = lookup[clean.charCodeAt(i + 2)]
    const e4 = lookup[clean.charCodeAt(i + 3)]
    if (p < byteLen) bytes[p++] = (e1 << 2) | (e2 >> 4)
    if (p < byteLen) bytes[p++] = ((e2 & 15) << 4) | (e3 >> 2)
    if (p < byteLen) bytes[p++] = ((e3 & 3) << 6) | (e4 & 63)
  }
  return bytes
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function makeBbox(a: Point, b: Point): [number, number, number, number] | null {
  const x1 = clamp01(Math.min(a.x, b.x))
  const y1 = clamp01(Math.min(a.y, b.y))
  const x2 = clamp01(Math.max(a.x, b.x))
  const y2 = clamp01(Math.max(a.y, b.y))
  const w = x2 - x1
  const h = y2 - y1
  if (w < 0.025 || h < 0.05) return null
  return [x1, y1, w, h]
}

export default function Train() {
  const router = useRouter()
  const [mode, setMode] = useState<TrainMode>('reference')
  const [catalog, setCatalog] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Product | null>(null)
  const [customName, setCustomName] = useState('')
  const [shots, setShots] = useState<Partial<Record<TrainSlot, LocalShot>>>({})
  const [shelfShot, setShelfShot] = useState<LocalShot | null>(null)
  const [annotations, setAnnotations] = useState<ShelfAnnotation[]>([])
  const [pendingPoint, setPendingPoint] = useState<Point | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [imageLayout, setImageLayout] = useState({ width: 1, height: 1 })

  useEffect(() => {
    ensureCatalogSeeded()
      .then(setCatalog)
      .catch((e: any) => Alert.alert('Load failed', String(e?.message ?? e)))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const bottles = catalog.filter((p) => /bottle/i.test(p.count_unit ?? ''))
    if (!q) return bottles.slice(0, selected ? 40 : 80)
    return bottles.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 80)
  }, [catalog, search, selected])

  const activeProductName = (customName.trim() || selected?.name || '').trim()

  const captureSlot = async (slot: TrainSlot) => {
    const { status: perm } = await ImagePicker.requestCameraPermissionsAsync()
    if (perm !== 'granted') {
      Alert.alert('Permission needed', 'Camera permission is required.')
      return
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.8,
      base64: false,
    })
    if (!result.canceled && result.assets[0]) {
      const jpeg = await toJpegSmall(result.assets[0].uri, 900)
      if (jpeg.base64) setShots((prev) => ({ ...prev, [slot]: jpeg }))
    }
  }

  const chooseShelfImage = async () => {
    const { status: perm } = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (perm !== 'granted') {
      Alert.alert('Permission needed', 'Photo library permission is required.')
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.85,
      base64: false,
    })
    if (!result.canceled && result.assets[0]) {
      setStatus('Preparing image...')
      try {
        const jpeg = await toJpegSmall(result.assets[0].uri, 1400)
        if (jpeg.base64) {
          setShelfShot(jpeg)
          setAnnotations([])
          setPendingPoint(null)
        }
      } finally {
        setStatus('')
      }
    }
  }

  const captureShelfImage = async () => {
    const { status: perm } = await ImagePicker.requestCameraPermissionsAsync()
    if (perm !== 'granted') {
      Alert.alert('Permission needed', 'Camera permission is required.')
      return
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.85,
      base64: false,
    })
    if (!result.canceled && result.assets[0]) {
      setStatus('Preparing image...')
      try {
        const jpeg = await toJpegSmall(result.assets[0].uri, 1400)
        if (jpeg.base64) {
          setShelfShot(jpeg)
          setAnnotations([])
          setPendingPoint(null)
        }
      } finally {
        setStatus('')
      }
    }
  }

  const handleShelfPress = (event: any) => {
    if (!shelfShot) return
    if (!activeProductName) {
      Alert.alert('Name needed', 'Select a product or type a custom bottle name before drawing a box.')
      return
    }
    const x = clamp01(event.nativeEvent.locationX / Math.max(imageLayout.width, 1))
    const y = clamp01(event.nativeEvent.locationY / Math.max(imageLayout.height, 1))
    const point = { x, y }

    if (!pendingPoint) {
      setPendingPoint(point)
      return
    }

    const bbox = makeBbox(pendingPoint, point)
    if (!bbox) {
      setPendingPoint(null)
      Alert.alert('Box too small', 'Tap the top-left and bottom-right corners of the full visible bottle.')
      return
    }

    setAnnotations((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${prev.length}`,
        bbox,
        product: activeProductName,
      },
    ])
    setPendingPoint(null)
  }

  const removeAnnotation = (id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id))
  }

  const saveTrainingSet = async () => {
    if (!selected) return Alert.alert('Choose product', 'Select the bottle these photos belong to.')
    const entries = SLOTS.map((slot) => ({ ...slot, shot: shots[slot.key] })).filter((x) => x.shot)
    if (entries.length === 0) return Alert.alert('No photos', 'Capture at least one training photo.')

    setSaving(true)
    setStatus('Saving references...')
    try {
      for (const entry of entries) {
        const shot = entry.shot!
        const bytes = base64ToUint8Array(shot.base64)
        const fileName = `${safeName(selected.name)}_${entry.key}_${Date.now()}.jpg`
        const { error: uploadError } = await supabase.storage
          .from('bottle-references')
          .upload(fileName, bytes, { contentType: 'image/jpeg', upsert: false })
        if (uploadError) throw uploadError
        const { data: urlData } = supabase.storage.from('bottle-references').getPublicUrl(fileName)
        const { error: insertError } = await (supabase as any)
          .from('bottle_references')
          .insert({
            product_name: selected.name,
            image_url: (urlData as any).publicUrl,
            priority: entry.priority,
            notes: `training:${entry.key}`,
          } as any)
        if (insertError) throw insertError
      }
      Alert.alert('Saved', `${entries.length} reference photo${entries.length === 1 ? '' : 's'} saved.`)
      setShots({})
    } catch (e: any) {
      Alert.alert('Save failed', String(e?.message ?? e))
    } finally {
      setSaving(false)
      setStatus('')
    }
  }

  const saveShelfAnnotations = async () => {
    if (!shelfShot) return Alert.alert('No image', 'Upload or capture a shelf image first.')
    if (annotations.length === 0) return Alert.alert('No boxes', 'Tap two corners around each bottle before saving.')

    setSaving(true)
    setStatus('Saving labeled shelf image...')
    try {
      const bytes = base64ToUint8Array(shelfShot.base64)
      const fileName = `training/shelf_${Date.now()}.jpg`
      const { error: uploadError } = await supabase.storage
        .from('inventory-images')
        .upload(fileName, bytes, { contentType: 'image/jpeg', upsert: false })
      if (uploadError) throw uploadError

      const { data: urlData } = supabase.storage.from('inventory-images').getPublicUrl(fileName)
      const imageUrl = (urlData as any).publicUrl

      const rows = annotations.map((annotation) => ({
        image_url: imageUrl,
        bbox: annotation.bbox,
        predicted_product: null,
        corrected_product: annotation.product,
        confidence: 1,
        source: 'train-manual-shelf',
        status: 'pending',
        notes: `manual shelf annotation ${shelfShot.width}x${shelfShot.height}`,
      }))

      const { error: insertError } = await (supabase as any)
        .from('training_annotations')
        .insert(rows as any)
      if (insertError) throw insertError

      Alert.alert('Saved', `${annotations.length} bottle annotation${annotations.length === 1 ? '' : 's'} saved for training.`)
      setAnnotations([])
      setPendingPoint(null)
    } catch (e: any) {
      Alert.alert('Save failed', String(e?.message ?? e))
    } finally {
      setSaving(false)
      setStatus('')
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 56, paddingBottom: 48 }}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={{ marginBottom: 18 }}>
          <Text style={{ color: theme.textMuted, fontSize: 15 }}>‹  Back</Text>
        </Pressable>

        <Text style={{ color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: 0.2 }}>
          Train
        </Text>
        <Text style={{ color: theme.textMuted, fontSize: 13, lineHeight: 18, marginTop: 6 }}>
          Add clean product references, or label bottles directly in a shelf image for the Roboflow training queue.
        </Text>

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 18 }}>
          <ModeButton label="References" active={mode === 'reference'} onPress={() => setMode('reference')} />
          <ModeButton label="Shelf labels" active={mode === 'shelf'} onPress={() => setMode('shelf')} />
        </View>

        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search product"
          placeholderTextColor={theme.textFaint}
          style={{
            backgroundColor: theme.surface,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 15,
            color: theme.text,
            marginTop: 18,
          }}
        />

        {mode === 'shelf' && (
          <TextInput
            value={customName}
            onChangeText={setCustomName}
            placeholder="Or type custom bottle name"
            placeholderTextColor={theme.textFaint}
            style={{
              backgroundColor: theme.surface,
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 12,
              fontSize: 15,
              color: theme.text,
              marginTop: 10,
            }}
          />
        )}

        {loading ? (
          <ActivityIndicator color={theme.text} style={{ marginTop: 24 }} />
        ) : (
          <View style={{ marginTop: 10, maxHeight: selected ? 150 : 260 }}>
            <ScrollView nestedScrollEnabled>
              {filtered.map((product) => {
                const active = selected?.id === product.id
                return (
                  <Pressable
                    key={product.id}
                    onPress={() => {
                      setSelected(product)
                      if (mode === 'shelf') setCustomName('')
                    }}
                    style={({ pressed }) => ({
                      paddingVertical: 11,
                      paddingHorizontal: 12,
                      borderRadius: 10,
                      marginBottom: 6,
                      backgroundColor: active
                        ? theme.accent
                        : pressed
                          ? '#26262a'
                          : theme.surface,
                    })}
                  >
                    <Text
                      style={{
                        color: active ? theme.accentText : theme.text,
                        fontSize: 13,
                        fontWeight: active ? '700' : '500',
                      }}
                      numberOfLines={1}
                    >
                      {product.name}
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        )}

        {mode === 'reference' && selected && (
          <View style={{ marginTop: 18 }}>
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: '700', marginBottom: 10 }}>
              {selected.name}
            </Text>
            <View style={{ gap: 10 }}>
              {SLOTS.map((slot) => {
                const shot = shots[slot.key]
                return (
                  <View
                    key={slot.key}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      backgroundColor: theme.surface,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: shot ? theme.border : '#3a3a40',
                      padding: 10,
                    }}
                  >
                    <View
                      style={{
                        width: 62,
                        height: 82,
                        borderRadius: 8,
                        backgroundColor: theme.surfaceAlt,
                        overflow: 'hidden',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {shot ? (
                        <Image source={{ uri: shot.uri }} style={{ width: 62, height: 82 }} />
                      ) : (
                        <Text style={{ color: theme.textFaint, fontSize: 11 }}>empty</Text>
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.text, fontSize: 14, fontWeight: '700' }}>
                        {slot.label}
                      </Text>
                      <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 2, lineHeight: 15 }}>
                        {slot.hint}
                      </Text>
                    </View>
                    <Pressable
                      disabled={saving}
                      onPress={() => captureSlot(slot.key)}
                      style={({ pressed }) => ({
                        paddingVertical: 8,
                        paddingHorizontal: 12,
                        borderRadius: 8,
                        backgroundColor: pressed ? '#2a2a2f' : shot ? theme.surfaceAlt : theme.accent,
                      })}
                    >
                      <Text style={{ color: shot ? theme.text : theme.accentText, fontSize: 12, fontWeight: '700' }}>
                        {shot ? 'Retake' : 'Capture'}
                      </Text>
                    </Pressable>
                  </View>
                )
              })}
            </View>

            {!!status && <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 10 }}>{status}</Text>}

            <Pressable
              disabled={saving}
              onPress={saveTrainingSet}
              style={({ pressed }) => ({
                marginTop: 16,
                padding: 16,
                borderRadius: 12,
                alignItems: 'center',
                backgroundColor: saving ? theme.surfaceAlt : pressed ? '#e7e7e9' : theme.accent,
              })}
            >
              {saving ? (
                <ActivityIndicator color={theme.text} />
              ) : (
                <Text style={{ color: theme.accentText, fontSize: 15, fontWeight: '700' }}>
                  Save training photos
                </Text>
              )}
            </Pressable>
          </View>
        )}

        {mode === 'shelf' && (
          <View style={{ marginTop: 18 }}>
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: '700' }}>
              Shelf image labels
            </Text>
            <Text style={{ color: theme.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4 }}>
              Select or type a bottle name, then tap the top-left and bottom-right corners of that bottle. Repeat for each visible bottle.
            </Text>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <ModeButton label="Upload image" onPress={chooseShelfImage} />
              <ModeButton label="Take photo" onPress={captureShelfImage} />
            </View>

            {!!activeProductName && (
              <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 10 }}>
                Current label: {activeProductName}
              </Text>
            )}

            {shelfShot ? (
              <View style={{ marginTop: 12 }}>
                <Pressable
                  onPress={handleShelfPress}
                  onLayout={(event) => setImageLayout(event.nativeEvent.layout)}
                  style={{
                    width: '100%',
                    aspectRatio: shelfShot.width / Math.max(shelfShot.height, 1),
                    borderRadius: 12,
                    overflow: 'hidden',
                    backgroundColor: theme.surface,
                    borderWidth: 1,
                    borderColor: theme.border,
                  }}
                >
                  <Image
                    source={{ uri: shelfShot.uri }}
                    style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }}
                    resizeMode="stretch"
                  />
                  {annotations.map((annotation, index) => {
                    const [x, y, w, h] = annotation.bbox
                    return (
                      <View
                        key={annotation.id}
                        pointerEvents="none"
                        style={{
                          position: 'absolute',
                          left: `${x * 100}%`,
                          top: `${y * 100}%`,
                          width: `${w * 100}%`,
                          height: `${h * 100}%`,
                          borderWidth: 2,
                          borderColor: '#34C759',
                          backgroundColor: 'rgba(52,199,89,0.14)',
                        }}
                      >
                        <Text
                          numberOfLines={1}
                          style={{
                            position: 'absolute',
                            left: 0,
                            top: -22,
                            maxWidth: 180,
                            color: '#000',
                            backgroundColor: '#34C759',
                            paddingHorizontal: 5,
                            paddingVertical: 2,
                            fontSize: 10,
                            fontWeight: '700',
                          }}
                        >
                          {index + 1}. {annotation.product}
                        </Text>
                      </View>
                    )
                  })}
                  {pendingPoint && (
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: `${pendingPoint.x * 100}%`,
                        top: `${pendingPoint.y * 100}%`,
                        width: 10,
                        height: 10,
                        marginLeft: -5,
                        marginTop: -5,
                        borderRadius: 5,
                        backgroundColor: '#ffcc00',
                      }}
                    />
                  )}
                </Pressable>

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <ModeButton label="Undo point" onPress={() => setPendingPoint(null)} />
                  <ModeButton
                    label="Clear boxes"
                    onPress={() => {
                      setAnnotations([])
                      setPendingPoint(null)
                    }}
                  />
                </View>

                <View style={{ gap: 8, marginTop: 12 }}>
                  {annotations.map((annotation, index) => (
                    <View
                      key={annotation.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        padding: 10,
                        backgroundColor: theme.surface,
                        borderRadius: 10,
                      }}
                    >
                      <Text style={{ color: theme.textMuted, width: 24 }}>{index + 1}</Text>
                      <Text style={{ color: theme.text, flex: 1 }} numberOfLines={1}>
                        {annotation.product}
                      </Text>
                      <Pressable onPress={() => removeAnnotation(annotation.id)}>
                        <Text style={{ color: '#ff6b6b', fontWeight: '700' }}>Remove</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              <Text style={{ color: theme.textFaint, fontSize: 13, fontStyle: 'italic', marginTop: 16 }}>
                No shelf image selected.
              </Text>
            )}

            {!!status && <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 10 }}>{status}</Text>}

            <Pressable
              disabled={saving}
              onPress={saveShelfAnnotations}
              style={({ pressed }) => ({
                marginTop: 16,
                padding: 16,
                borderRadius: 12,
                alignItems: 'center',
                backgroundColor: saving ? theme.surfaceAlt : pressed ? '#e7e7e9' : theme.accent,
              })}
            >
              {saving ? (
                <ActivityIndicator color={theme.text} />
              ) : (
                <Text style={{ color: theme.accentText, fontSize: 15, fontWeight: '700' }}>
                  Save shelf labels
                </Text>
              )}
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  )
}

function ModeButton({
  label,
  onPress,
  active,
}: {
  label: string
  onPress: () => void
  active?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        paddingVertical: 12,
        paddingHorizontal: 10,
        borderRadius: 10,
        alignItems: 'center',
        backgroundColor: pressed ? '#26262a' : active ? theme.accent : theme.surface,
        borderWidth: 1,
        borderColor: active ? theme.accent : theme.border,
      })}
    >
      <Text style={{ color: active ? theme.accentText : theme.text, fontSize: 13, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  )
}
