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

interface LocalShot {
  uri: string
  base64: string
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

async function toJpegSmall(uri: string): Promise<LocalShot> {
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 900 } }], {
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  })
  return { uri: result.uri, base64: result.base64 ?? '' }
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

export default function Train() {
  const router = useRouter()
  const [catalog, setCatalog] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Product | null>(null)
  const [shots, setShots] = useState<Partial<Record<TrainSlot, LocalShot>>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

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
      const jpeg = await toJpegSmall(result.assets[0].uri)
      if (jpeg.base64) setShots((prev) => ({ ...prev, [slot]: jpeg }))
    }
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
          Add clean front, back, and barcode references for one bottle. These improve product matching immediately and can later be exported into Roboflow.
        </Text>

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
                    onPress={() => setSelected(product)}
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

        {selected && (
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
      </ScrollView>
    </View>
  )
}
