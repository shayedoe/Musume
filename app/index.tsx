import { useState } from 'react'
import { View, Text, Pressable, Image, Modal, StatusBar } from 'react-native'
import { useRouter } from 'expo-router'
import { theme } from '../lib/theme'

export default function Home() {
  const router = useRouter()
  const [sheetOpen, setSheetOpen] = useState(false)

  const go = (path: string) => {
    setSheetOpen(false)
    setTimeout(() => router.push(path), 120)
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

      {/* Logo pinned to the left edge, vertically filling the screen */}
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

      {/* Main content shifted right so it doesn't overlap the logo */}
      <View
        style={{
          flex: 1,
          paddingLeft: 160,
          paddingRight: 24,
          justifyContent: 'center',
        }}
      >
        <Pressable
          onPress={() => setSheetOpen(true)}
          style={({ pressed }) => ({
            paddingVertical: 20,
            paddingHorizontal: 28,
            borderRadius: 14,
            backgroundColor: pressed ? '#e7e7e9' : theme.accent,
            alignItems: 'center',
          })}
        >
          <Text style={{ color: theme.accentText, fontSize: 18, fontWeight: '700', letterSpacing: 0.3 }}>
            Inventory
          </Text>
        </Pressable>

        <Pressable
          onPress={() => router.push('/references')}
          style={{ marginTop: 16, alignItems: 'center', paddingVertical: 10 }}
        >
          <Text style={{ color: theme.textMuted, fontSize: 13, letterSpacing: 0.3 }}>
            References
          </Text>
        </Pressable>
      </View>

      <Modal
        visible={sheetOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSheetOpen(false)}
      >
        <Pressable
          onPress={() => setSheetOpen(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: theme.surface,
              borderTopLeftRadius: 22,
              borderTopRightRadius: 22,
              padding: 22,
              paddingBottom: 40,
              borderTopWidth: 1,
              borderColor: theme.border,
            }}
          >
            <View
              style={{
                alignSelf: 'center',
                width: 40,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.border,
                marginBottom: 18,
              }}
            />
            <Text
              style={{
                color: theme.text,
                fontSize: 18,
                fontWeight: '600',
                marginBottom: 16,
                letterSpacing: 0.3,
              }}
            >
              New Count
            </Text>

            <SheetButton label="Take Photo" onPress={() => go('/camera?mode=camera')} primary />
            <SheetButton label="Upload Photo" onPress={() => go('/camera?mode=library')} />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

function SheetButton({
  label,
  onPress,
  primary,
}: {
  label: string
  onPress: () => void
  primary?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 16,
        paddingHorizontal: 20,
        borderRadius: 12,
        marginBottom: 10,
        backgroundColor: primary
          ? pressed
            ? '#e7e7e9'
            : theme.accent
          : pressed
            ? '#26262a'
            : theme.surfaceAlt,
        alignItems: 'center',
      })}
    >
      <Text
        style={{
          color: primary ? theme.accentText : theme.text,
          fontSize: 16,
          fontWeight: '600',
          letterSpacing: 0.2,
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}
