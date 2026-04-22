import { View, Text, Pressable } from 'react-native'
import { useRouter } from 'expo-router'

export default function Home() {
  const router = useRouter()

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: 24, marginBottom: 20 }}>Inventory Vision</Text>
      <Pressable onPress={() => router.push('/camera')}>
        <Text style={{ fontSize: 18 }}>Start Session</Text>
      </Pressable>
    </View>
  )
}
