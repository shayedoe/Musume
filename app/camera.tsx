import { useEffect, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  Alert,
  ActivityIndicator,
  Image,
  ScrollView,
  StatusBar,
} from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { supabase } from '../lib/supabase'
import { analyzeShelfImage, mergeDetections } from '../lib/vision'
import { ensureCatalogSeeded, matchProduct } from '../lib/catalog'
import { theme } from '../lib/theme'
import type { Product, VisionDetectionResult } from '../lib/types'

interface LocalShot {
  uri: string
  base64: string
}

async function toJpeg(uri: string): Promise<{ uri: string; base64: string }> {
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1600 } }], {
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  })
  return { uri: result.uri, base64: result.base64 ?? '' }
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
      Alert.alert('Permission needed', 'Camera permission is required.')
      return
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.7,
      base64: false,
    })
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0]
      const jpeg = await toJpeg(a.uri)
      if (jpeg.base64) setShots((prev) => [...prev, jpeg])
    }
  }

  const addFromLibrary = async () => {
    const { status: perm } = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (perm !== 'granted') {
      Alert.alert('Permission needed', 'Photo library permission is required.')
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.7,
      base64: false,
      allowsMultipleSelection: true,
      selectionLimit: 6,
    })
    if (!result.canceled) {
      setStatus('Converting...')
      try {
        const next: LocalShot[] = []
        for (const a of result.assets) {
          const jpeg = await toJpeg(a.uri)
          if (jpeg.base64) next.push(jpeg)
        }
        setShots((prev) => [...prev, ...next])
      } finally {
        setStatus('')
      }
    }
  }

  const removeShot = (idx: number) => {
    setShots((prev) => prev.filter((_, i) => i !== idx))
  }

  const analyzeAndUpload = async () => {
    if (shots.length === 0) {
      Alert.alert('No photos', 'Add at least one photo.')
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

      setStatus('Analyzing...')
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
        const response = await fetch(`data:image/jpeg;base64,${shot.base64}`)
        const blob = await response.blob()
        const fileName = `${sessionId}/${Date.now()}_${i}.jpg`
        const { error: uploadError } = await supabase.storage
          .from('inventory-images')
          .upload(fileName, blob, { contentType: 'image/jpeg', upsert: false })
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

      setStatus('Saving...')
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
        Alert.alert('Nothing detected', 'You can add rows manually on the next screen.')
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
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 60 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 24 }}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ marginRight: 12 }}>
            <Text style={{ color: theme.textMuted, fontSize: 15 }}>‹  Back</Text>
          </Pressable>
        </View>

        <Text style={{ color: theme.text, fontSize: 26, fontWeight: '700', marginBottom: 22, letterSpacing: 0.2 }}>
          Capture
        </Text>

        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 18 }}>
          <ToolbarButton label="Camera" onPress={addFromCamera} active={initialMode === 'camera'} />
          <ToolbarButton label="Upload" onPress={addFromLibrary} active={initialMode === 'library'} />
        </View>

        {!!status && !busy && (
          <Text style={{ color: theme.textMuted, fontSize: 13, marginBottom: 12 }}>{status}</Text>
        )}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 22 }}>
          {shots.map((s, idx) => (
            <View key={idx} style={{ position: 'relative' }}>
              <Image
                source={{ uri: s.uri }}
                style={{
                  width: 100,
                  height: 140,
                  borderRadius: 10,
                  backgroundColor: theme.surface,
                }}
              />
              <Pressable
                onPress={() => removeShot(idx)}
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  backgroundColor: 'rgba(0,0,0,0.7)',
                  borderRadius: 12,
                  width: 24,
                  height: 24,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 14, lineHeight: 16 }}>×</Text>
              </Pressable>
            </View>
          ))}
          {shots.length === 0 && (
            <Text style={{ color: theme.textFaint, fontSize: 13, fontStyle: 'italic' }}>
              No photos yet.
            </Text>
          )}
        </View>

        {shots.length > 0 && (
          <Pressable
            onPress={analyzeAndUpload}
            disabled={busy}
            style={({ pressed }) => ({
              padding: 18,
              backgroundColor: busy ? theme.surfaceAlt : pressed ? '#e7e7e9' : theme.accent,
              borderRadius: 12,
              alignItems: 'center',
            })}
          >
            {busy ? (
              <View style={{ alignItems: 'center' }}>
                <ActivityIndicator color={theme.text} />
                {!!status && (
                  <Text style={{ color: theme.text, marginTop: 6, fontSize: 13 }}>{status}</Text>
                )}
              </View>
            ) : (
              <Text style={{ color: theme.accentText, fontSize: 16, fontWeight: '700', letterSpacing: 0.3 }}>
                Analyze {shots.length} photo{shots.length > 1 ? 's' : ''}
              </Text>
            )}
          </Pressable>
        )}
      </ScrollView>
    </View>
  )
}

function ToolbarButton({
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
        paddingVertical: 14,
        borderRadius: 10,
        alignItems: 'center',
        backgroundColor: pressed ? '#26262a' : active ? theme.surfaceAlt : theme.surface,
        borderWidth: 1,
        borderColor: active ? theme.border : 'transparent',
      })}
    >
      <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600', letterSpacing: 0.2 }}>
        {label}
      </Text>
    </Pressable>
  )
}
