import { useEffect, useState } from 'react'
import { View, Text, Pressable, Alert, ActivityIndicator, Image, ScrollView } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import { supabase } from '../lib/supabase'
import { analyzeShelfImage, mergeDetections } from '../lib/vision'
import { ensureCatalogSeeded, matchProduct } from '../lib/catalog'
import type { Product, VisionDetectionResult } from '../lib/types'

interface LocalShot {
  uri: string
  base64: string
}

export default function Camera() {
  const router = useRouter()
  const { mode } = useLocalSearchParams<{ mode?: string }>()
  const initialMode: 'camera' | 'library' = mode === 'library' ? 'library' : 'camera'

  const [shots, setShots] = useState<LocalShot[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [catalog, setCatalog] = useState<Product[]>([])

  useEffect(() => {
    ensureCatalogSeeded().then(setCatalog).catch(() => {})
  }, [])

  const addFromCamera = async () => {
    const { status: perm } = await ImagePicker.requestCameraPermissionsAsync()
    if (perm !== 'granted') {
      Alert.alert('Permission needed', 'Camera permission is required to take photos.')
      return
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.7,
      base64: true,
    })
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0]
      if (a.base64) setShots((prev) => [...prev, { uri: a.uri, base64: a.base64! }])
    }
  }

  const addFromLibrary = async () => {
    const { status: perm } = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (perm !== 'granted') {
      Alert.alert('Permission needed', 'Photo library permission is required to upload photos.')
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.7,
      base64: true,
      allowsMultipleSelection: true,
      selectionLimit: 6,
    })
    if (!result.canceled) {
      const next = result.assets
        .filter((a) => !!a.base64)
        .map((a) => ({ uri: a.uri, base64: a.base64! }))
      setShots((prev) => [...prev, ...next])
    }
  }

  const removeShot = (idx: number) => {
    setShots((prev) => prev.filter((_, i) => i !== idx))
  }

  const analyzeAndUpload = async () => {
    if (shots.length === 0) {
      Alert.alert('No photos', 'Add at least one shelf photo first.')
      return
    }
    setBusy(true)
    try {
      setStatus('Creating session...')
      const { data: sessionData, error: sessionError } = await (supabase as any)
        .from('inventory_sessions')
        .insert({} as any)
        .select()
        .single()
      if (sessionError) throw sessionError
      const sessionId = (sessionData as any).id as string

      setStatus('Analyzing bottles with AI...')
      const catalogHint = catalog.map((c) => c.name)
      const analyses = await Promise.allSettled(
        shots.map((s) => analyzeShelfImage(s.base64, catalogHint))
      )

      const perPhotoDetections: VisionDetectionResult[][] = []
      const warnings: string[] = []
      analyses.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          perPhotoDetections.push(r.value.detections)
          if (r.value.warnings?.length) warnings.push(...r.value.warnings)
        } else {
          warnings.push(`Photo ${i + 1}: ${r.reason?.message ?? 'analysis failed'}`)
          perPhotoDetections.push([])
        }
      })

      setStatus('Uploading photos...')
      const photoIds: string[] = []
      for (let i = 0; i < shots.length; i++) {
        const shot = shots[i]
        const response = await fetch(shot.uri)
        const blob = await response.blob()
        const fileName = `${sessionId}/${Date.now()}_${i}.jpg`
        const { error: uploadError } = await supabase.storage
          .from('inventory-images')
          .upload(fileName, blob, { contentType: 'image/jpeg' })
        if (uploadError) throw uploadError
        const { data: urlData } = supabase.storage
          .from('inventory-images')
          .getPublicUrl(fileName)
        const { data: photoData, error: photoError } = await (supabase as any)
          .from('photos')
          .insert({ session_id: sessionId, image_url: (urlData as any).publicUrl } as any)
          .select()
          .single()
        if (photoError) throw photoError
        photoIds.push((photoData as any).id)
      }

      setStatus('Saving detections...')
      const detectionRows: any[] = []
      perPhotoDetections.forEach((dets, i) => {
        const photoId = photoIds[i]
        for (const d of dets) {
          const match = matchProduct(d.product, catalog)
          detectionRows.push({
            photo_id: photoId,
            session_id: sessionId,
            predicted_product: d.product,
            matched_product_id: match?.id ?? null,
            count: d.count,
            fill_level: d.fill_level,
            confidence: d.confidence ?? null,
            notes: d.notes ?? null,
            status: 'pending',
          })
        }
      })
      if (detectionRows.length > 0) {
        const { error: detError } = await (supabase as any)
          .from('detections')
          .insert(detectionRows as any)
        if (detError) throw detError
      }

      const merged = mergeDetections(perPhotoDetections)
      if (warnings.length > 0) {
        Alert.alert('Finished with warnings', warnings.slice(0, 4).join('\n'))
      } else if (merged.length === 0) {
        Alert.alert('No bottles detected', 'Review screen will let you add items manually.')
      }

      router.push(`/review?session_id=${sessionId}`)
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to process session')
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }} contentContainerStyle={{ padding: 20 }}>
      <Text style={{ fontSize: 22, fontWeight: '700', marginBottom: 4 }}>Capture Shelf Photos</Text>
      <Text style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        Take one or more photos, or upload from your library. The AI will detect bottles, count duplicates,
        and estimate fill level (1 = full, 0.5 = half, 0.1 = nearly empty).
      </Text>

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
        <Pressable
          onPress={addFromCamera}
          style={{ flex: 1, padding: 14, backgroundColor: '#007AFF', borderRadius: 8, alignItems: 'center' }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>+ Camera</Text>
        </Pressable>
        <Pressable
          onPress={addFromLibrary}
          style={{ flex: 1, padding: 14, backgroundColor: '#34C759', borderRadius: 8, alignItems: 'center' }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>+ Upload</Text>
        </Pressable>
      </View>

      {initialMode === 'library' && shots.length === 0 && (
        <Text style={{ color: '#888', fontStyle: 'italic', marginBottom: 12 }}>
          Tip: Upload a photo of your back-bar or stock shelf to test bottle detection.
        </Text>
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {shots.map((s, idx) => (
          <View key={idx} style={{ position: 'relative' }}>
            <Image source={{ uri: s.uri }} style={{ width: 100, height: 140, borderRadius: 8 }} />
            <Pressable
              onPress={() => removeShot(idx)}
              style={{
                position: 'absolute', top: 4, right: 4,
                backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 12,
                width: 24, height: 24, alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontSize: 14 }}>×</Text>
            </Pressable>
          </View>
        ))}
      </View>

      {shots.length > 0 && (
        <Pressable
          onPress={analyzeAndUpload}
          disabled={busy}
          style={{
            padding: 16, backgroundColor: busy ? '#ccc' : '#111',
            borderRadius: 10, alignItems: 'center', marginBottom: 12,
          }}
        >
          {busy ? (
            <View style={{ alignItems: 'center' }}>
              <ActivityIndicator color="#fff" />
              {!!status && <Text style={{ color: '#fff', marginTop: 6 }}>{status}</Text>}
            </View>
          ) : (
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
              Analyze {shots.length} photo{shots.length > 1 ? 's' : ''}
            </Text>
          )}
        </Pressable>
      )}

      <Pressable onPress={() => router.back()} style={{ padding: 12, alignItems: 'center' }}>
        <Text style={{ color: '#007AFF' }}>Back</Text>
      </Pressable>
    </ScrollView>
  )
}
