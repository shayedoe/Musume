import { useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  Alert,
  ActivityIndicator,
  Image,
  ScrollView,
  TextInput,
  FlatList,
} from 'react-native'
import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { supabase } from '../lib/supabase'
import { ensureCatalogSeeded } from '../lib/catalog'
import type { Product } from '../lib/types'

interface BottleReferenceRow {
  id: string
  product_name: string
  image_url: string
  priority: number | null
  notes: string | null
}

// Re-encode to JPEG (HEIC safety) and downscale — references don't need
// full resolution.
async function toJpegSmall(uri: string): Promise<{ base64: string }> {
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 640 } }], {
    compress: 0.75,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  })
  return { base64: result.base64 ?? '' }
}

export default function References() {
  const router = useRouter()
  const [catalog, setCatalog] = useState<Product[]>([])
  const [refs, setRefs] = useState<BottleReferenceRow[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploadingFor, setUploadingFor] = useState<string | null>(null)
  const [autoSeeding, setAutoSeeding] = useState(false)
  const [autoSeedStatus, setAutoSeedStatus] = useState<string>('')

  const load = async () => {
    try {
      setBusy(true)
      const cat = await ensureCatalogSeeded()
      setCatalog(cat)
      const { data, error } = await supabase
        .from('bottle_references' as any)
        .select('id, product_name, image_url, priority, notes')
        .order('priority', { ascending: true })
        .order('product_name', { ascending: true })
      if (error) throw error
      setRefs((data ?? []) as BottleReferenceRow[])
    } catch (e: any) {
      Alert.alert('Load failed', String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const refsByProduct = useMemo(() => {
    const m = new Map<string, BottleReferenceRow[]>()
    for (const r of refs) {
      const key = r.product_name
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(r)
    }
    return m
  }, [refs])

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase()
    const bottles = catalog.filter((p) => /bottle/i.test(p.count_unit ?? ''))
    if (!q) return bottles.slice(0, 150)
    return bottles.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 150)
  }, [catalog, search])

  const addReferenceFor = async (productName: string, source: 'camera' | 'library') => {
    try {
      if (source === 'camera') {
        const { status } = await ImagePicker.requestCameraPermissionsAsync()
        if (status !== 'granted') {
          Alert.alert('Permission needed', 'Camera permission is required.')
          return
        }
      } else {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
        if (status !== 'granted') {
          Alert.alert('Permission needed', 'Photo library permission is required.')
          return
        }
      }
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              quality: 0.7,
              base64: false,
            })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              quality: 0.7,
              base64: false,
            })
      if (result.canceled || !result.assets?.[0]) return
      setUploadingFor(productName)
      const jpeg = await toJpegSmall(result.assets[0].uri)
      if (!jpeg.base64) throw new Error('JPEG conversion failed')

      const response = await fetch(`data:image/jpeg;base64,${jpeg.base64}`)
      const blob = await response.blob()
      const safeName = productName.replace(/[^a-z0-9]+/gi, '_').toLowerCase()
      const fileName = `${safeName}_${Date.now()}.jpg`
      const { error: upErr } = await supabase.storage
        .from('bottle-references')
        .upload(fileName, blob, { contentType: 'image/jpeg', upsert: false })
      if (upErr) throw upErr

      const { data: urlData } = supabase.storage
        .from('bottle-references')
        .getPublicUrl(fileName)
      const image_url = (urlData as any).publicUrl

      const { error: insErr } = await (supabase as any)
        .from('bottle_references')
        .insert({ product_name: productName, image_url, priority: 100 })
      if (insErr) throw insErr

      await load()
    } catch (e: any) {
      Alert.alert('Upload failed', String(e?.message ?? e))
    } finally {
      setUploadingFor(null)
    }
  }

  const autoSeedBatch = async (limit: number) => {
    try {
      const extra: any = Constants.expoConfig?.extra ?? {}
      const visionEndpoint: string | undefined = extra.visionEndpoint
      if (!visionEndpoint) throw new Error('Vision endpoint not configured')
      const seedEndpoint = visionEndpoint.replace(/\/vision-analyze\/?$/, '/seed-references')
      const anonKey: string | undefined = extra.supabaseAnonKey

      const existing = new Set(refs.map((r) => r.product_name))
      const bottles = catalog.filter((p) => /bottle/i.test(p.count_unit ?? ''))
      const targets = bottles.filter((p) => !existing.has(p.name)).slice(0, limit)
      if (!targets.length) {
        Alert.alert('Nothing to seed', 'Every bottle already has a reference image.')
        return
      }

      setAutoSeeding(true)
      setAutoSeedStatus(`Searching for ${targets.length} bottles... (can take 1–3 min)`)

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (anonKey) {
        headers['Authorization'] = `Bearer ${anonKey}`
        headers['apikey'] = anonKey
      }
      const res = await fetch(seedEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ products: targets.map((p) => p.name), skip_existing: true }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `status ${res.status}`)

      const ok = body?.summary?.ok ?? 0
      const failed = body?.summary?.failed ?? 0
      setAutoSeedStatus(`Seeded ${ok} of ${targets.length}. ${failed} failed.`)
      await load()
    } catch (e: any) {
      Alert.alert('Auto-seed failed', String(e?.message ?? e))
      setAutoSeedStatus('')
    } finally {
      setAutoSeeding(false)
    }
  }

  const deleteReference = async (r: BottleReferenceRow) => {
    Alert.alert('Delete reference?', r.product_name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const { error } = await (supabase as any)
              .from('bottle_references')
              .delete()
              .eq('id', r.id)
            if (error) throw error
            // best-effort remove storage file
            try {
              const path = r.image_url.split('/bottle-references/')[1]
              if (path) await supabase.storage.from('bottle-references').remove([path])
            } catch {}
            await load()
          } catch (e: any) {
            Alert.alert('Delete failed', String(e?.message ?? e))
          }
        },
      },
    ])
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#fff', paddingTop: 48 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
        <Pressable onPress={() => router.back()} style={{ padding: 8, marginRight: 8 }}>
          <Text style={{ fontSize: 16, color: '#007AFF' }}>‹ Back</Text>
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: '700' }}>Bottle Reference Gallery</Text>
      </View>
      <Text style={{ paddingHorizontal: 16, color: '#666', marginBottom: 8, fontSize: 12 }}>
        Add a photo of each bottle you stock. The AI uses these images to match + count bottles
        in shelf photos more accurately. First 25 (lowest priority number) are sent per analysis.
      </Text>

      <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
        <Pressable
          disabled={autoSeeding}
          onPress={() => autoSeedBatch(50)}
          style={{
            padding: 12,
            backgroundColor: autoSeeding ? '#aaa' : '#AF52DE',
            borderRadius: 8,
            alignItems: 'center',
          }}
        >
          {autoSeeding ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <ActivityIndicator color="#fff" style={{ marginRight: 8 }} />
              <Text style={{ color: '#fff', fontWeight: '600' }}>Auto-seeding...</Text>
            </View>
          ) : (
            <Text style={{ color: '#fff', fontWeight: '600' }}>
              🔍 Auto-seed next 50 bottles from web
            </Text>
          )}
        </Pressable>
        {!!autoSeedStatus && (
          <Text style={{ fontSize: 12, color: '#666', marginTop: 6, textAlign: 'center' }}>
            {autoSeedStatus}
          </Text>
        )}
      </View>

      <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search products..."
          placeholderTextColor="#999"
          style={{
            borderWidth: 1,
            borderColor: '#ddd',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 15,
          }}
        />
      </View>

      {busy && refs.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={filteredCatalog}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          renderItem={({ item: product }) => {
            const existing = refsByProduct.get(product.name) ?? []
            const isBusyHere = uploadingFor === product.name
            return (
              <View
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: '#eee',
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600' }}>{product.name}</Text>
                <Text style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
                  {existing.length} reference{existing.length === 1 ? '' : 's'}
                </Text>
                {existing.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 6 }}>
                    {existing.map((r) => (
                      <Pressable
                        key={r.id}
                        onLongPress={() => deleteReference(r)}
                        style={{ marginRight: 8 }}
                      >
                        <Image
                          source={{ uri: r.image_url }}
                          style={{ width: 64, height: 64, borderRadius: 6, backgroundColor: '#eee' }}
                        />
                      </Pressable>
                    ))}
                  </ScrollView>
                )}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    disabled={isBusyHere}
                    onPress={() => addReferenceFor(product.name, 'camera')}
                    style={{
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      backgroundColor: isBusyHere ? '#aaa' : '#007AFF',
                      borderRadius: 6,
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                      {isBusyHere ? 'Uploading...' : '📷 Snap'}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={isBusyHere}
                    onPress={() => addReferenceFor(product.name, 'library')}
                    style={{
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      backgroundColor: isBusyHere ? '#aaa' : '#34C759',
                      borderRadius: 6,
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                      🖼 Pick
                    </Text>
                  </Pressable>
                </View>
              </View>
            )
          }}
          ListEmptyComponent={
            <Text style={{ textAlign: 'center', marginTop: 32, color: '#999' }}>
              No products match.
            </Text>
          }
        />
      )}
    </View>
  )
}
