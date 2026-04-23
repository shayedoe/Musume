import { useEffect, useState, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StatusBar,
  Alert,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'

interface SessionRow {
  id: string
  created_at: string
  status?: string | null
  line_count: number
  bottle_count: number
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export default function History() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState<SessionRow[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: sessData, error } = await (supabase as any)
        .from('inventory_sessions')
        .select('id, created_at, status')
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw error
      const sessList = (sessData as any[]) ?? []

      // Pull final_counts for each session to compute summary stats.
      const { data: fc } = await (supabase as any)
        .from('final_counts')
        .select('session_id, quantity')
      const fcBySession = new Map<string, { lines: number; qty: number }>()
      for (const r of ((fc as any[]) ?? [])) {
        const sid = r.session_id as string
        const qty = Number(r.quantity ?? 0) || 0
        const prev = fcBySession.get(sid) ?? { lines: 0, qty: 0 }
        prev.lines += 1
        prev.qty += qty
        fcBySession.set(sid, prev)
      }

      const rows: SessionRow[] = sessList.map((s: any) => {
        const agg = fcBySession.get(s.id) ?? { lines: 0, qty: 0 }
        return {
          id: s.id,
          created_at: s.created_at,
          status: s.status ?? null,
          line_count: agg.lines,
          bottle_count: Math.round(agg.qty * 100) / 100,
        }
      })
      setSessions(rows)
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  // Reload every time the screen gains focus.
  useFocusEffect(
    useCallback(() => {
      load()
    }, [load])
  )

  const deleteSession = async (id: string) => {
    Alert.alert(
      'Delete inventory?',
      'This removes the session and its photos from history.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const { error } = await (supabase as any)
                .from('inventory_sessions')
                .delete()
                .eq('id', id)
              if (error) throw error
              setSessions((prev) => prev.filter((s) => s.id !== id))
            } catch (e: any) {
              Alert.alert('Error', e.message || 'Delete failed')
            }
          },
        },
      ]
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 60, paddingBottom: 60 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Text style={{ color: theme.textMuted, fontSize: 15 }}>‹  Back</Text>
          </Pressable>
        </View>

        <Text style={{ color: theme.text, fontSize: 26, fontWeight: '700', letterSpacing: 0.2 }}>
          Past Inventories
        </Text>
        <Text style={{ color: theme.textMuted, fontSize: 13, marginTop: 4, marginBottom: 18 }}>
          Tap to open, long-press to delete.
        </Text>

        {loading && (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={theme.text} />
          </View>
        )}

        {!loading && sessions.length === 0 && (
          <View
            style={{
              paddingVertical: 40,
              alignItems: 'center',
              backgroundColor: theme.surface,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.border,
            }}
          >
            <Text style={{ color: theme.textMuted, fontSize: 14 }}>No saved inventories yet.</Text>
          </View>
        )}

        {!loading &&
          sessions.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => router.push(`/review?session_id=${s.id}`)}
              onLongPress={() => deleteSession(s.id)}
              style={({ pressed }) => ({
                backgroundColor: pressed ? '#26262a' : theme.surface,
                borderRadius: 12,
                padding: 14,
                marginBottom: 10,
                borderWidth: 1,
                borderColor: theme.border,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>
                    {formatDate(s.created_at)}
                  </Text>
                  <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 3 }}>
                    {s.line_count === 0
                      ? 'No saved counts'
                      : `${s.line_count} line${s.line_count === 1 ? '' : 's'} · ${s.bottle_count} bottles`}
                  </Text>
                </View>
                <Text style={{ color: theme.textFaint, fontSize: 18 }}>›</Text>
              </View>
            </Pressable>
          ))}
      </ScrollView>
    </View>
  )
}
