import { useState } from 'react'
import { View, Text, Pressable, Image, StatusBar, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'

export default function Home() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const startInventory = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { data, error } = await (supabase as any)
        .from('inventory_sessions')
        .insert({} as any)
        .select()
        .single()
      if (error) throw error
      const id = (data as any).id as string
      router.push(`/camera?session_id=${id}`)
    } catch (e: any) {
      Alert.alert('Could not start', e.message || 'Failed to create session')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -20,
          top: 0,
          bottom: 0,
          justifyContent: 'center',
        }}
      >
        <Image
          source={require('../assets/musume-logo.png')}
          resizeMode="contain"
          style={{ width: 200, height: '90%', opacity: 0.95 }}
        />
      </View>

      <View
        style={{
          flex: 1,
          paddingLeft: 160,
          paddingRight: 24,
          justifyContent: 'center',
          gap: 12,
        }}
      >
        <Pressable
          onPress={startInventory}
          disabled={busy}
          style={({ pressed }) => ({
            paddingVertical: 20,
            paddingHorizontal: 28,
            borderRadius: 14,
            backgroundColor: busy ? theme.surfaceAlt : pressed ? '#e7e7e9' : theme.accent,
            alignItems: 'center',
          })}
        >
          <Text
            style={{
              color: busy ? theme.textMuted : theme.accentText,
              fontSize: 18,
              fontWeight: '700',
              letterSpacing: 0.3,
            }}
          >
            {busy ? 'Starting…' : 'Start Inventory'}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => router.push('/history')}
          style={({ pressed }) => ({
            paddingVertical: 16,
            paddingHorizontal: 24,
            borderRadius: 12,
            backgroundColor: pressed ? '#26262a' : theme.surface,
            borderWidth: 1,
            borderColor: theme.border,
            alignItems: 'center',
          })}
        >
          <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>
            Past Inventories
          </Text>
        </Pressable>

        <Pressable
          onPress={() => router.push('/references')}
          style={{ marginTop: 6, alignItems: 'center', paddingVertical: 8 }}
        >
          <Text style={{ color: theme.textMuted, fontSize: 13, letterSpacing: 0.3 }}>
            References
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
