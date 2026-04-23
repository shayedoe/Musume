import { Stack } from 'expo-router'
import * as Updates from 'expo-updates'
import { useEffect } from 'react'
import { AppState } from 'react-native'

export default function Layout() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return
      try {
        const res = await Updates.checkForUpdateAsync()
        if (res.isAvailable) {
          await Updates.fetchUpdateAsync()
          await Updates.reloadAsync()
        }
      } catch {
        // offline or dev client — ignore
      }
    })
    return () => sub.remove()
  }, [])

  return <Stack screenOptions={{ headerShown: false }} />
}
