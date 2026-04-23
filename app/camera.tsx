import { useState } from 'react'
import { View, Text, Pressable, Alert, ActivityIndicator, Image } from 'react-native'
import { useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import * as FileSystem from 'expo-file-system'
import { supabase } from '../lib/supabase'

export default function Camera() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [imageUri, setImageUri] = useState<string | null>(null)

  const requestCameraPermission = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync()
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Camera permission is required to take photos')
      return false
    }
    return true
  }

  const takePicture = async () => {
    const hasPermission = await requestCameraPermission()
    if (!hasPermission) return

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.8,
    })

    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri)
    }
  }

  const uploadAndCreateSession = async () => {
    if (!imageUri) return

    setLoading(true)
    try {
      // Create inventory session
      const { data: sessionData, error: sessionError } = (await (supabase as any)
        .from('inventory_sessions')
        .insert({} as any)
        .select()
        .single()) as any

      if (sessionError) throw sessionError

      // Read image file as blob
      const response = await fetch(imageUri)
      const blob = await response.blob()

      // Generate unique filename
      const fileName = `${(sessionData as any).id}/${Date.now()}.jpg`

      // Upload to Supabase storage
      const { error: uploadError } = await supabase.storage
        .from('inventory-images')
        .upload(fileName, blob, {
          contentType: 'image/jpeg',
        })

      if (uploadError) throw uploadError

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('inventory-images')
        .getPublicUrl(fileName)

      // Save photo record
      const { error: photoError } = await ((supabase as any)
        .from('photos')
        .insert({
          session_id: (sessionData as any).id,
          image_url: (urlData as any).publicUrl,
        } as any) as any)

      if (photoError) throw photoError

      // Navigate to review screen
      router.push(`/review?session_id=${(sessionData as any).id}`)
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to upload image')
    } finally {
      setLoading(false)
    }
  }

  return (
    <View style={{ flex: 1, padding: 20, backgroundColor: '#fff' }}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        {imageUri ? (
          <>
            <Image
              source={{ uri: imageUri }}
              style={{ width: 300, height: 400, marginBottom: 20, borderRadius: 10 }}
              resizeMode="contain"
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={() => setImageUri(null)}
                style={{
                  padding: 15,
                  backgroundColor: '#666',
                  borderRadius: 8,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 16 }}>Retake</Text>
              </Pressable>
              <Pressable
                onPress={uploadAndCreateSession}
                disabled={loading}
                style={{
                  padding: 15,
                  backgroundColor: loading ? '#ccc' : '#007AFF',
                  borderRadius: 8,
                }}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontSize: 16 }}>Continue</Text>
                )}
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={{ fontSize: 20, marginBottom: 30 }}>Capture Shelf Photo</Text>
            <Pressable
              onPress={takePicture}
              style={{
                padding: 20,
                backgroundColor: '#007AFF',
                borderRadius: 8,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 18 }}>Open Camera</Text>
            </Pressable>
          </>
        )}
      </View>
      <Pressable
        onPress={() => router.back()}
        style={{ padding: 15, alignItems: 'center' }}
      >
        <Text style={{ color: '#007AFF', fontSize: 16 }}>Back to Home</Text>
      </Pressable>
    </View>
  )
}

// no-op: blob upload handled via fetch
