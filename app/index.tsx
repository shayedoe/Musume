import { View, Text, Pressable } from 'react-native'
import { useRouter } from 'expo-router'

export default function Home() {
  const router = useRouter()

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#fff' }}>
      <Text style={{ fontSize: 28, fontWeight: '700', marginBottom: 8 }}>Inventory Vision</Text>
      <Text style={{ fontSize: 14, color: '#666', marginBottom: 32, textAlign: 'center' }}>
        Snap or upload shelf photos. AI proposes bottles, counts, and fill levels. You review and export.
      </Text>

      <Pressable
        onPress={() => router.push('/camera?mode=camera')}
        style={{ padding: 16, backgroundColor: '#007AFF', borderRadius: 10, width: 260, alignItems: 'center', marginBottom: 12 }}
      >
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600' }}>Start Session – Take Photo</Text>
      </Pressable>

      <Pressable
        onPress={() => router.push('/camera?mode=library')}
        style={{ padding: 16, backgroundColor: '#34C759', borderRadius: 10, width: 260, alignItems: 'center' }}
      >
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600' }}>Start Session – Upload Photo</Text>
      </Pressable>
    </View>
  )
}
