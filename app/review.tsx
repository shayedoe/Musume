import { useState, useEffect } from 'react'
import { View, Text, TextInput, Pressable, Alert, ScrollView, Image, ActivityIndicator } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import * as Sharing from 'expo-sharing'
import * as FileSystem from 'expo-file-system'
import { supabase } from '../lib/supabase'

interface CountItem {
  id: string
  product: string
  quantity: string
  section: string
}

export default function Review() {
  const router = useRouter()
  const { session_id } = useLocalSearchParams()
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [counts, setCounts] = useState<CountItem[]>([
    { id: '1', product: '', quantity: '', section: 'Shelf A' }
  ])

  useEffect(() => {
    loadSessionData()
  }, [])

  const loadSessionData = async () => {
    try {
      // Load photo for this session
      const { data: photoData, error: photoError } = await supabase
        .from('photos')
        .select('image_url')
        .eq('session_id', session_id)
        .single()

      if (photoError) throw photoError
      setImageUrl(photoData.image_url)

      // Load existing counts if any
      const { data: countsData, error: countsError } = await supabase
        .from('final_counts')
        .select('*')
        .eq('session_id', session_id)

      if (countsError && countsError.code !== 'PGRST116') throw countsError

      if (countsData && countsData.length > 0) {
        setCounts(countsData.map((c: any, idx: number) => ({
          id: String(idx + 1),
          product: c.product || '',
          quantity: String(c.quantity || ''),
          section: c.section || 'Shelf A'
        })))
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to load session data')
    } finally {
      setLoading(false)
    }
  }

  const addNewRow = () => {
    setCounts([...counts, {
      id: String(counts.length + 1),
      product: '',
      quantity: '',
      section: 'Shelf A'
    }])
  }

  const updateCount = (id: string, field: keyof CountItem, value: string) => {
    setCounts(counts.map((c: CountItem) => c.id === id ? { ...c, [field]: value } : c))
  }

  const removeCount = (id: string) => {
    if (counts.length > 1) {
      setCounts(counts.filter((c: CountItem) => c.id !== id))
    }
  }

  const saveCounts = async () => {
    try {
      // Delete existing counts
      const { error: deleteError } = await supabase
        .from('final_counts')
        .delete()
        .eq('session_id', session_id)

      if (deleteError) throw deleteError
      // Insert new counts
      const validCounts = counts.filter((c: CountItem) => c.product.trim() && c.quantity.trim())

      if (validCounts.length === 0) {
        Alert.alert('No data', 'Please add at least one product with quantity')
        return
      }

      const parsedCounts = validCounts.map((c: CountItem) => ({
        ...c,
        parsedQuantity: parseFloat(c.quantity)
      }))

      const invalidCount = parsedCounts.find((c) => !Number.isFinite(c.parsedQuantity))

      if (invalidCount) {
        Alert.alert('Invalid quantity', `Please enter a valid number for ${invalidCount.product || 'the product'} before saving`)
        return
      }

      const { error } = await supabase
        .from('final_counts')
        .insert(parsedCounts.map((c) => ({
          session_id,
          product: c.product,
          quantity: c.parsedQuantity,
          section: c.section
        })))

      if (error) throw error
      Alert.alert('Success', 'Counts saved successfully')
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to save counts')
    }
  }

  const exportToCSV = async () => {
    setExporting(true)
    try {
      const validCounts = counts.filter((c: CountItem) => c.product.trim() && c.quantity.trim())

      if (validCounts.length === 0) {
        Alert.alert('No data', 'Please add at least one product with quantity')
        return
      }

      // Generate CSV content
      const csvHeader = 'Product,Count,Unit,Section\n'
      const csvRows = validCounts.map((c: CountItem) =>
        `${c.product},${c.quantity},bottle,${c.section}`
      ).join('\n')
      const csvContent = csvHeader + csvRows

      // Save to file
      const fileName = `inventory_${session_id}_${Date.now()}.csv`
      const filePath = `${FileSystem.documentDirectory}${fileName}`

      await FileSystem.writeAsStringAsync(filePath, csvContent, {
        encoding: FileSystem.EncodingType.UTF8
      })

      // Share file
      const canShare = await Sharing.isAvailableAsync()
      if (canShare) {
        await Sharing.shareAsync(filePath, {
          mimeType: 'text/csv',
          dialogTitle: 'Export Inventory CSV'
        })
      } else {
        Alert.alert('Success', `CSV saved to ${filePath}`)
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to export CSV')
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    )
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ padding: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 20 }}>
          Review & Count
        </Text>

        {imageUrl && (
          <Image
            source={{ uri: imageUrl }}
            style={{ width: '100%', height: 200, marginBottom: 20, borderRadius: 10 }}
            resizeMode="contain"
          />
        )}

        <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 15 }}>
          Manual Counts
        </Text>

        {counts.map((count: CountItem, index: number) => (
          <View
            key={count.id}
            style={{
              padding: 15,
              backgroundColor: '#f5f5f5',
              borderRadius: 8,
              marginBottom: 10
            }}
          >
            <TextInput
              placeholder="Product name"
              value={count.product}
              onChangeText={(text: string) => updateCount(count.id, 'product', text)}
              style={{
                padding: 10,
                backgroundColor: '#fff',
                borderRadius: 5,
                marginBottom: 8,
                fontSize: 16
              }}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
              <TextInput
                placeholder="Quantity"
                value={count.quantity}
                onChangeText={(text: string) => updateCount(count.id, 'quantity', text)}
                keyboardType="decimal-pad"
                style={{
                  flex: 1,
                  padding: 10,
                  backgroundColor: '#fff',
                  borderRadius: 5,
                  fontSize: 16
                }}
              />
              <TextInput
                placeholder="Section"
                value={count.section}
                onChangeText={(text: string) => updateCount(count.id, 'section', text)}
                style={{
                  flex: 1,
                  padding: 10,
                  backgroundColor: '#fff',
                  borderRadius: 5,
                  fontSize: 16
                }}
              />
            </View>
            {counts.length > 1 && (
              <Pressable
                onPress={() => removeCount(count.id)}
                style={{ alignSelf: 'flex-end' }}
              >
                <Text style={{ color: '#ff3b30', fontSize: 14 }}>Remove</Text>
              </Pressable>
            )}
          </View>
        ))}

        <Pressable
          onPress={addNewRow}
          style={{
            padding: 15,
            backgroundColor: '#e0e0e0',
            borderRadius: 8,
            alignItems: 'center',
            marginBottom: 20
          }}
        >
          <Text style={{ fontSize: 16, color: '#333' }}>+ Add Another Item</Text>
        </Pressable>

        <View style={{ gap: 10 }}>
          <Pressable
            onPress={saveCounts}
            style={{
              padding: 15,
              backgroundColor: '#34C759',
              borderRadius: 8,
              alignItems: 'center'
            }}
          >
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600' }}>
              Save Counts
            </Text>
          </Pressable>

          <Pressable
            onPress={exportToCSV}
            disabled={exporting}
            style={{
              padding: 15,
              backgroundColor: exporting ? '#ccc' : '#007AFF',
              borderRadius: 8,
              alignItems: 'center'
            }}
          >
            {exporting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600' }}>
                Export CSV
              </Text>
            )}
          </Pressable>

          <Pressable
            onPress={() => router.push('/')}
            style={{
              padding: 15,
              backgroundColor: '#666',
              borderRadius: 8,
              alignItems: 'center'
            }}
          >
            <Text style={{ color: '#fff', fontSize: 18 }}>
              Back to Home
            </Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  )
}
