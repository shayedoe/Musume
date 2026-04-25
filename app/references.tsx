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
  StatusBar,
} from 'react-native'
import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { supabase } from '../lib/supabase'
import { ensureCatalogSeeded } from '../lib/catalog'
import { theme } from '../lib/theme'
import type { Product } from '../lib/types'

interface BottleReferenceRow {
  id: string
  product_name: string
  image_url: string
  priority: number | null
  notes: string | null
}

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
  const [filterMode, setFilterMode] = useState<'all' | 'missing' | 'has'>('all')

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
    let items = bottles
    if (filterMode === 'missing') {
      items = items.filter((p) => !refsByProduct.has(p.name))
    } else if (filterMode === 'has') {
      items = items.filter((p) => refsByProduct.has(p.name))
    }
    if (q) items = items.filter((p) => p.name.toLowerCase().includes(q))
    return items.slice(0, 200)
  }, [catalog, search, filterMode, refsByProduct])

  const addReferenceFor = async (productName: string, source: 'camera' | 'library') => {
    try {
      if (source === 'camera') {
        const { status } = await ImagePicker.requestCameraPermissionsAsync()
        if (status !== 'granted') return Alert.alert('Permission needed', 'Camera permission is required.')
      } else {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
        if (status !== 'granted') return Alert.alert('Permission needed', 'Photo library permission is required.')
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

      const { data: urlData } = supabase.storage.from('bottle-references').getPublicUrl(fileName)
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
      setAutoSeedStatus(`Searching for ${targets.length} bottles… (1–3 min)`)

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

  const totalBottles = useMemo(
    () => catalog.filter((p) => /bottle/i.test(p.count_unit ?? '')).length,
    [catalog]
  )
  const withRefs = refsByProduct.size

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

      <View style={{ paddingTop: 56, paddingHorizontal: 20, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ marginRight: 12 }}>
            <Text style={{ color: theme.textMuted, fontSize: 15 }}>‹  Back</Text>
          </Pressable>
        </View>
        <Text style={{ color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: 0.2 }}>
          References
        </Text>
        <Text style={{ color: theme.textMuted, fontSize: 13, marginTop: 4 }}>
          {withRefs} of {totalBottles} bottles have a reference image.
        </Text>
      </View>

      <View style={{ paddingHorizontal: 20, marginTop: 14 }}>
        <Pressable
          onPress={() => router.push('/train')}
          style={({ pressed }) => ({
            padding: 14,
            backgroundColor: pressed ? '#26262a' : theme.surface,
            borderRadius: 12,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: theme.border,
            marginBottom: 10,
          })}
        >
          <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14 }}>
            Analyze bottle
          </Text>
        </Pressable>

        <Pressable
          disabled={autoSeeding}
          onPress={() => autoSeedBatch(50)}
          style={({ pressed }) => ({
            padding: 14,
            backgroundColor: autoSeeding
              ? theme.surfaceAlt
              : pressed
                ? '#e7e7e9'
                : theme.accent,
            borderRadius: 12,
            alignItems: 'center',
          })}
        >
          {autoSeeding ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <ActivityIndicator color={theme.text} style={{ marginRight: 8 }} />
              <Text style={{ color: theme.text, fontWeight: '600', fontSize: 14 }}>
                Auto-seeding…
              </Text>
            </View>
          ) : (
            <Text style={{ color: theme.accentText, fontWeight: '700', fontSize: 14, letterSpacing: 0.3 }}>
              Auto-seed next 50
            </Text>
          )}
        </Pressable>
        {!!autoSeedStatus && (
          <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 8, textAlign: 'center' }}>
            {autoSeedStatus}
          </Text>
        )}
      </View>

      <View style={{ paddingHorizontal: 20, marginTop: 16, marginBottom: 12 }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search products"
          placeholderTextColor={theme.textFaint}
          style={{
            backgroundColor: theme.surface,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 15,
            color: theme.text,
          }}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <FilterChip label="All" active={filterMode === 'all'} onPress={() => setFilterMode('all')} />
          <FilterChip
            label="Missing"
            active={filterMode === 'missing'}
            onPress={() => setFilterMode('missing')}
          />
          <FilterChip
            label="Has refs"
            active={filterMode === 'has'}
            onPress={() => setFilterMode('has')}
          />
        </View>
      </View>

      {busy && refs.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={theme.text} />
      ) : (
        <FlatList
          data={filteredCatalog}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
          renderItem={({ item: product }) => {
            const existing = refsByProduct.get(product.name) ?? []
            const isBusyHere = uploadingFor === product.name
            return (
              <View
                style={{
                  backgroundColor: theme.surface,
                  borderRadius: 12,
                  padding: 14,
                  marginBottom: 10,
                  borderWidth: 1,
                  borderColor: theme.border,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }}>
                      {product.name}
                    </Text>
                    <Text style={{ color: theme.textFaint, fontSize: 11, marginTop: 2 }}>
                      {existing.length === 0
                        ? 'no references'
                        : `${existing.length} reference${existing.length === 1 ? '' : 's'}`}
                    </Text>
                  </View>
                  {existing.length > 0 && (
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: theme.success,
                        marginLeft: 8,
                      }}
                    />
                  )}
                </View>

                {existing.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ marginBottom: 10 }}
                  >
                    {existing.map((r) => (
                      <Pressable
                        key={r.id}
                        onLongPress={() => deleteReference(r)}
                        style={{ marginRight: 8 }}
                      >
                        <Image
                          source={{ uri: r.image_url }}
                          style={{
                            width: 58,
                            height: 58,
                            borderRadius: 8,
                            backgroundColor: theme.surfaceAlt,
                          }}
                        />
                      </Pressable>
                    ))}
                  </ScrollView>
                )}

                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    disabled={isBusyHere}
                    onPress={() => addReferenceFor(product.name, 'camera')}
                    style={({ pressed }) => ({
                      flex: 1,
                      paddingVertical: 10,
                      backgroundColor: pressed ? '#2f2f34' : theme.surfaceAlt,
                      borderRadius: 8,
                      alignItems: 'center',
                    })}
                  >
                    <Text style={{ color: theme.text, fontSize: 13, fontWeight: '500' }}>
                      {isBusyHere ? 'Uploading…' : 'Camera'}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={isBusyHere}
                    onPress={() => addReferenceFor(product.name, 'library')}
                    style={({ pressed }) => ({
                      flex: 1,
                      paddingVertical: 10,
                      backgroundColor: pressed ? '#2f2f34' : theme.surfaceAlt,
                      borderRadius: 8,
                      alignItems: 'center',
                    })}
                  >
                    <Text style={{ color: theme.text, fontSize: 13, fontWeight: '500' }}>
                      Library
                    </Text>
                  </Pressable>
                </View>
              </View>
            )
          }}
          ListEmptyComponent={
            <Text
              style={{
                textAlign: 'center',
                marginTop: 32,
                color: theme.textFaint,
                fontSize: 13,
              }}
            >
              No products match.
            </Text>
          }
        />
      )}
    </View>
  )
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string
  active?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 16,
        backgroundColor: active
          ? theme.accent
          : pressed
            ? '#26262a'
            : theme.surface,
        borderWidth: 1,
        borderColor: active ? theme.accent : theme.border,
      })}
    >
      <Text
        style={{
          color: active ? theme.accentText : theme.textMuted,
          fontSize: 12,
          fontWeight: '600',
          letterSpacing: 0.2,
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}
