import * as FileSystem from 'expo-file-system'
import { ProcessedDetection, RawDetection, processDetections, summarizeProcessing } from './detectionPostProcess'

export type BottleLabel = {
  brand?: string
  product_name?: string
  confidence?: number
  reason?: string
}

export type VisionResult = {
  rawDetections: RawDetection[]
  processedDetections: ProcessedDetection[]
  labels: BottleLabel[]
  overlayUri: string | null
  summary: {
    rawCount: number
    processedCount: number
    removedCount: number
  }
}

function getRoboflowConfig() {
  const apiKey = process.env.EXPO_PUBLIC_ROBOFLOW_API_KEY
  const workspace = process.env.EXPO_PUBLIC_ROBOFLOW_WORKSPACE
  const workflow = process.env.EXPO_PUBLIC_ROBOFLOW_WORKFLOW

  if (!apiKey || !workspace || !workflow) {
    throw new Error('Missing Roboflow env vars: EXPO_PUBLIC_ROBOFLOW_API_KEY, EXPO_PUBLIC_ROBOFLOW_WORKSPACE, EXPO_PUBLIC_ROBOFLOW_WORKFLOW')
  }

  return { apiKey, workspace, workflow }
}

function findOutput(outputs: any[], name: string) {
  return outputs.find((output) => output?.name === name || output?.[name] !== undefined)
}

function extractOverlayUri(outputs: any[]): string | null {
  const overlayOutput = findOutput(outputs, 'image') ?? findOutput(outputs, 'overlay')
  const image = overlayOutput?.image ?? overlayOutput?.overlay ?? overlayOutput
  const value = image?.value ?? image
  const type = image?.type

  if (typeof value !== 'string') return null
  if (value.startsWith('data:image')) return value
  if (type === 'base64' || value.length > 100) return `data:image/jpeg;base64,${value}`
  return value
}

function extractDetections(outputs: any[]): RawDetection[] {
  const detectionOutput = findOutput(outputs, 'detections')
  const detections = detectionOutput?.detections ?? detectionOutput?.predictions ?? detectionOutput
  return Array.isArray(detections) ? detections : []
}

function extractLabels(outputs: any[]): BottleLabel[] {
  const labelOutput = findOutput(outputs, 'labels')
  const labels = labelOutput?.labels ?? labelOutput
  if (Array.isArray(labels)) return labels
  if (labels && typeof labels === 'object') return [labels]
  return []
}

export function mergeDetectionsWithLabels(detections: ProcessedDetection[], labels: BottleLabel[]) {
  return detections.map((detection, index) => {
    const label = labels[index] ?? {}
    const brand = label.brand?.trim() || 'unknown'
    const productName = label.product_name?.trim() || 'unknown'

    return {
      ...detection,
      brand,
      product_name: productName,
      product: brand === 'unknown' && productName === 'unknown' ? 'unknown' : `${brand} ${productName}`.trim(),
      label_confidence: label.confidence ?? 0,
      label_reason: label.reason ?? '',
    }
  })
}

export async function analyzeInventoryImage(imageUri: string, imageWidth: number, imageHeight: number): Promise<VisionResult> {
  const { apiKey, workspace, workflow } = getRoboflowConfig()
  const imageBase64 = await FileSystem.readAsStringAsync(imageUri, {
    encoding: FileSystem.EncodingType.Base64,
  })

  const response = await fetch(`https://detect.roboflow.com/workflows/${workspace}/${workflow}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      images: {
        image: [{
          type: 'base64',
          value: imageBase64,
        }],
      },
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Roboflow workflow failed: ${response.status} ${errorText}`)
  }

  const result = await response.json()
  const outputs = result?.outputs ?? []
  const rawDetections = extractDetections(outputs)
  const labels = extractLabels(outputs)
  const processedDetections = processDetections(rawDetections, imageWidth, imageHeight)

  return {
    rawDetections,
    processedDetections,
    labels,
    overlayUri: extractOverlayUri(outputs),
    summary: summarizeProcessing(rawDetections, processedDetections),
  }
}
