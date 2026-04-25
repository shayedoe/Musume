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
import { analyzeShelfImage, mergeDetections, mergeMaxPerProduct } from '../lib/vision'
import { ensureCatalogSeeded, matchProduct } from '../lib/catalog'
import { theme } from '../lib/theme'
import type { BottleAnnotation, Product, VisionAnalysisResponse, VisionDetectionResult } from '../lib/types'

interface LocalShot {
  uri: string
  base64: string
}

type Angle = 'left' | 'front' | 'right'
const ANGLE_ORDER: Angle[] = ['left', 'front', 'right']
const ANGLE_LABEL: Record<Angle, string> = {
  left: 'Left side',
  front: 'Front',
  right: 'Right side',
}
const ANGLE_HINT: Record<Angle, string> = {
  left: 'Stand to the left of the bundle so you can see labels on the left-facing bottles.',
  front: 'Stand directly in front of the bundle. Include the whole group in frame.',
  right: 'Step around to the right side. Capture any labels that were hidden in the other two shots.',
}

async function toJpeg(uri: string): Promise<{ uri: string; base64: string }> {
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1600 } }], {
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  })
  return { uri: result.uri, base64: result.base64 ?? '' }
}

// Decode a base64 string to a Uint8Array without relying on Blob/atob.
// Works in React Native where `fetch('data:...').blob()` produces a 0-byte
// blob on iOS and `atob` is not always polyfilled.
function base64ToUint8Array(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lookup = new Uint8Array(256)
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i
  // Strip data-URL prefix and any whitespace/newlines.
  const clean = b64.replace(/^data:.*?;base64,/, '').replace(/\s+/g, '')
  let len = clean.length
  let padding = 0
  if (len >= 1 && clean[len - 1] === '=') padding++
  if (len >= 2 && clean[len - 2] === '=') padding++
  const byteLen = (len * 3) / 4 - padding
  const bytes = new Uint8Array(byteLen)
  let p = 0
  for (let i = 0; i < len; i += 4) {
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

type CaptureMode = 'single' | 'bundle' | 'library'

export default function Camera() {
  const router = useRouter()
  const { mode, session_id } = useLocalSearchParams<{ mode?: string; session_id?: string }>()
  const initialMode: CaptureMode = mode === 'library' ? 'library' : 'single'

  const [captureMode, setCaptureMode] = useState<CaptureMode>(initialMode)
  const [shots, setShots] = useState<LocalShot[]>([])
  // Bundle (multi-angle) shots, keyed by angle so the user can retake one.
  const [bundle, setBundle] = useState<Partial<Record<Angle, LocalShot>>>({})
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

  const captureAngle = async (angle: Angle) => {
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
      const jpeg = await toJpeg(result.assets[0].uri)
      if (jpeg.base64) setBundle((prev) => ({ ...prev, [angle]: jpeg }))
    }
  }

  const clearBundleAngle = (angle: Angle) => {
    setBundle((prev) => {
      const next = { ...prev }
      delete next[angle]
      return next
    })
  }

  const startTrain = () => {
    router.push('/train')
  }

  const analyzeAndUpload = async () => {
    // Assemble the photo list + merge strategy based on capture mode.
    // - single / library: keep legacy SUM merge (each photo may show a
    //   different section of the bar, so counts should add).
    // - bundle:            MAX-per-product merge across the 3 angles, since
    //                      each angle shows the same physical bottles.
    const isBundle = captureMode === 'bundle'
    const orderedBundle: LocalShot[] = isBundle
      ? (ANGLE_ORDER.map((a) => bundle[a]).filter(Boolean) as LocalShot[])
      : []
    const photosToUpload: LocalShot[] = isBundle ? orderedBundle : shots

    if (isBundle && orderedBundle.length < 3) {
      Alert.alert(
        'Need all 3 angles',
        'Please capture Left, Front, and Right shots of the bundle.'
      )
      return
    }
    if (!isBundle && shots.length === 0) {
      Alert.alert('No photos', 'Add at least one photo.')
      return
    }
    setBusy(true)
    try {
      // Reuse session from Home, or fall back to creating one.
      // session_id may come back as string | string[] from useLocalSearchParams.
      const incoming = Array.isArray(session_id) ? session_id[0] : session_id
      let sessionId: string | undefined = incoming && incoming.length > 0 ? incoming : undefined

      // Verify the passed session actually still exists. If it was deleted
      // (or never created cleanly) we'd hit a FK violation on the photos
      // insert below. Create a fresh one instead.
      if (sessionId) {
        const { data: existing } = await (supabase as any)
          .from('inventory_sessions')
          .select('id')
          .eq('id', sessionId)
          .maybeSingle()
        if (!existing) sessionId = undefined
      }

      if (!sessionId) {
        setStatus('Creating session...')
        const { data: sessionData, error: sessionError } = await (supabase as any)
          .from('inventory_sessions')
          .insert({} as any)
          .select()
          .single()
        if (sessionError) throw sessionError
        sessionId = (sessionData as any).id as string
      }

      setStatus(isBundle ? 'Analyzing 3 angles...' : 'Analyzing...')
      const catalogHint = catalog.map((c) => c.name)
      const analyses = await Promise.allSettled(
        photosToUpload.map((s) => analyzeShelfImage(s.base64, catalogHint))
      )

      const perPhotoDetections: VisionDetectionResult[][] = []
      const perPhotoAnnotations: BottleAnnotation[][] = []
      const perPhotoWarnings: string[][] = []
      const perPhotoMeta: Array<Record<string, unknown> | undefined> = []
      const warnings: string[] = []
      analyses.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          const v = r.value as VisionAnalysisResponse
          perPhotoDetections.push(v.detections)
          perPhotoAnnotations.push(v.annotations ?? [])
          perPhotoWarnings.push(v.warnings ?? [])
          perPhotoMeta.push(v.meta)
          if (v.warnings?.length) warnings.push(...v.warnings)
        } else {
          const warning = `Photo ${i + 1}: ${r.reason?.message ?? 'analysis failed'}`
          warnings.push(warning)
          perPhotoDetections.push([])
          perPhotoAnnotations.push([])
          perPhotoWarnings.push([warning])
          perPhotoMeta.push(undefined)
        }
      })

      setStatus('Uploading photos...')
      for (let i = 0; i < photosToUpload.length; i++) {
        const shot = photosToUpload[i]
        // React Native's fetch('data:...').blob() produces a 0-byte blob on
        // iOS, which silently uploads a broken file. Decode the base64 to a
        // Uint8Array and upload the raw bytes instead.
        const bytes = base64ToUint8Array(shot.base64)
        const fileName = `${sessionId}/${Date.now()}_${i}.jpg`
        const { error: uploadError } = await supabase.storage
          .from('inventory-images')
          .upload(fileName, bytes, { contentType: 'image/jpeg', upsert: false })
        if (uploadError) throw uploadError
        const { data: urlData } = supabase.storage
          .from('inventory-images')
          .getPublicUrl(fileName)
        const imageUrl = (urlData as any).publicUrl
        // Insert with annotations; retry without if the column doesn't exist yet.
        const { error: photoError } = await (supabase as any)
          .from('photos')
          .insert({
            session_id: sessionId,
            image_url: imageUrl,
            annotations: perPhotoAnnotations[i] ?? [],
          } as any)
        if (photoError) {
          const { error: retryErr } = await (supabase as any)
            .from('photos')
            .insert({
              session_id: sessionId,
              image_url: imageUrl,
            } as any)
          if (retryErr) throw retryErr
        }
        const { error: debugError } = await (supabase as any)
          .from('vision_debug_logs')
          .insert({
            session_id: sessionId,
            image_url: imageUrl,
            photo_index: i,
            capture_mode: captureMode,
            detections: perPhotoDetections[i] ?? [],
            annotations: perPhotoAnnotations[i] ?? [],
            warnings: perPhotoWarnings[i] ?? [],
            meta: perPhotoMeta[i] ?? {},
          } as any)
        if (debugError) console.warn('[camera.vision_debug_logs]', debugError.message)
      }

      setStatus('Saving...')
      // Canonicalize via catalog so model name variants collapse.
      const canonicalize = (raw: string): string => {
        const m = matchProduct(raw, catalog)
        return m?.name ?? raw
      }
      const merged = isBundle
        ? mergeMaxPerProduct(perPhotoDetections, canonicalize)
        : mergeDetections(perPhotoDetections, canonicalize)
      // Full-only mode: we don't track partial fills yet, so every
      // detection row is saved with fill_level=1.
      const detectionRows: any[] = merged.map((d) => {
        const match = matchProduct(d.product, catalog)
        return {
          photo_id: null,
          session_id: sessionId,
          predicted_product: d.product,
          matched_product_id: match?.id ?? null,
          count: d.count,
          fill_level: 1,
          confidence: d.confidence ?? null,
          notes: d.notes ?? null,
          status: 'pending',
        }
      })
      if (detectionRows.length > 0) {
        const { error: detError } = await (supabase as any)
          .from('detections')
          .insert(detectionRows as any)
        if (detError) throw detError
      }

      if (warnings.length > 0) {
        Alert.alert('Finished with warnings', warnings.slice(0, 4).join('\n'))
      } else if (merged.length === 0) {
        Alert.alert('Nothing detected', 'You can add rows manually on the next screen.')
      }

      router.push(`/review?session_id=${sessionId}`)
    } catch (error: any) {
      const msg =
        (typeof error === 'string' && error) ||
        error?.message ||
        error?.error_description ||
        error?.code ||
        (error ? JSON.stringify(error).slice(0, 300) : '') ||
        'Failed to process session'
      console.error('[camera.analyzeAndUpload]', error)
      Alert.alert('Error', msg)
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

        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 18 }}>
          <ToolbarButton
            label="Photo"
            onPress={() => setCaptureMode('single')}
            active={captureMode === 'single'}
          />
          <ToolbarButton
            label="Bundle"
            onPress={() => setCaptureMode('bundle')}
            active={captureMode === 'bundle'}
          />
          <ToolbarButton
            label="Upload"
            onPress={() => setCaptureMode('library')}
            active={captureMode === 'library'}
          />
          <ToolbarButton label="Train" onPress={startTrain} />
        </View>

        {captureMode === 'bundle' && (
          <Text
            style={{
              color: theme.textMuted,
              fontSize: 12,
              lineHeight: 17,
              marginBottom: 14,
            }}
          >
            Capture the same bundle from 3 angles so labels hidden in one view
            can be read from another. We keep the MAX count per product across
            angles — no double-counting.
          </Text>
        )}

        {captureMode === 'single' && (
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
            <ToolbarButton label="Take photo" onPress={addFromCamera} />
          </View>
        )}

        {captureMode === 'library' && (
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
            <ToolbarButton label="Choose photos" onPress={addFromLibrary} />
          </View>
        )}

        {captureMode === 'bundle' && (
          <View style={{ gap: 10, marginBottom: 18 }}>
            {ANGLE_ORDER.map((angle) => {
              const shot = bundle[angle]
              return (
                <View
                  key={angle}
                  style={{
                    flexDirection: 'row',
                    backgroundColor: theme.surface,
                    borderRadius: 12,
                    padding: 10,
                    borderWidth: 1,
                    borderColor: shot ? theme.border : '#3a3a40',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <View
                    style={{
                      width: 64,
                      height: 84,
                      borderRadius: 8,
                      backgroundColor: theme.surfaceAlt,
                      overflow: 'hidden',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {shot ? (
                      <Image source={{ uri: shot.uri }} style={{ width: 64, height: 84 }} />
                    ) : (
                      <Text style={{ color: theme.textFaint, fontSize: 11 }}>empty</Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ color: theme.text, fontSize: 14, fontWeight: '700' }}
                    >
                      {ANGLE_LABEL[angle]}
                    </Text>
                    <Text
                      style={{
                        color: theme.textMuted,
                        fontSize: 11,
                        marginTop: 2,
                        lineHeight: 15,
                      }}
                    >
                      {ANGLE_HINT[angle]}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => (shot ? clearBundleAngle(angle) : captureAngle(angle))}
                    style={({ pressed }) => ({
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      borderRadius: 8,
                      backgroundColor: pressed
                        ? '#2a2a2f'
                        : shot
                          ? theme.surfaceAlt
                          : theme.accent,
                    })}
                  >
                    <Text
                      style={{
                        color: shot ? theme.text : theme.accentText,
                        fontSize: 12,
                        fontWeight: '700',
                      }}
                    >
                      {shot ? 'Retake' : 'Capture'}
                    </Text>
                  </Pressable>
                </View>
              )
            })}
          </View>
        )}

        {!!status && !busy && (
          <Text style={{ color: theme.textMuted, fontSize: 13, marginBottom: 12 }}>{status}</Text>
        )}

        {captureMode !== 'bundle' && (
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
        )}

        {(captureMode === 'bundle'
          ? Object.keys(bundle).length === 3
          : shots.length > 0) && (
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
                {captureMode === 'bundle'
                  ? 'Analyze 3-angle bundle'
                  : `Analyze ${shots.length} photo${shots.length > 1 ? 's' : ''}`}
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
