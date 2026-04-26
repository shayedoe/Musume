export type RawDetection = {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  class?: string
  class_id?: number
  [key: string]: unknown
}

export type ProcessedDetection = RawDetection & {
  x1: number
  y1: number
  x2: number
  y2: number
  area: number
  aspectRatio: number
  relativeHeight: number
  relativeArea: number
}

export type DetectionProcessingOptions = {
  confidenceThreshold?: number
  minAspectRatio?: number
  minRelativeHeight?: number
  minRelativeArea?: number
  nmsIouThreshold?: number
  nestedContainmentThreshold?: number
}

const DEFAULT_OPTIONS: Required<DetectionProcessingOptions> = {
  confidenceThreshold: 0.5,
  minAspectRatio: 1.5,
  minRelativeHeight: 0.12,
  minRelativeArea: 0.0035,
  nmsIouThreshold: 0.45,
  nestedContainmentThreshold: 0.68,
}

export function normalizeDetection(
  detection: RawDetection,
  imageWidth: number,
  imageHeight: number
): ProcessedDetection {
  const x1 = detection.x - detection.width / 2
  const y1 = detection.y - detection.height / 2
  const x2 = detection.x + detection.width / 2
  const y2 = detection.y + detection.height / 2
  const area = detection.width * detection.height

  return {
    ...detection,
    x1,
    y1,
    x2,
    y2,
    area,
    aspectRatio: detection.height / Math.max(detection.width, 1),
    relativeHeight: detection.height / Math.max(imageHeight, 1),
    relativeArea: area / Math.max(imageWidth * imageHeight, 1),
  }
}

export function iou(a: ProcessedDetection, b: ProcessedDetection): number {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.area + b.area - intersection

  return union <= 0 ? 0 : intersection / union
}

function containedRatio(smaller: ProcessedDetection, larger: ProcessedDetection): number {
  const x1 = Math.max(smaller.x1, larger.x1)
  const y1 = Math.max(smaller.y1, larger.y1)
  const x2 = Math.min(smaller.x2, larger.x2)
  const y2 = Math.min(smaller.y2, larger.y2)

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return intersection / Math.max(smaller.area, 1)
}

export function processDetections(
  detections: RawDetection[],
  imageWidth: number,
  imageHeight: number,
  options: DetectionProcessingOptions = {}
): ProcessedDetection[] {
  const config = { ...DEFAULT_OPTIONS, ...options }

  const normalized = detections.map((detection) =>
    normalizeDetection(detection, imageWidth, imageHeight)
  )

  const bottleLike = normalized.filter((detection) => {
    if (detection.confidence < config.confidenceThreshold) return false
    if (detection.aspectRatio < config.minAspectRatio) return false
    if (detection.relativeHeight < config.minRelativeHeight) return false
    if (detection.relativeArea < config.minRelativeArea) return false
    return true
  })

  const withoutNestedFragments = bottleLike.filter((candidate) => {
    return !bottleLike.some((other) => {
      if (candidate === other) return false
      if (candidate.area >= other.area) return false
      return containedRatio(candidate, other) > config.nestedContainmentThreshold
    })
  })

  const sorted = [...withoutNestedFragments].sort((a, b) => b.confidence - a.confidence)
  const kept: ProcessedDetection[] = []

  while (sorted.length > 0) {
    const current = sorted.shift()
    if (!current) break

    kept.push(current)

    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      if (iou(current, sorted[index]) > config.nmsIouThreshold) {
        sorted.splice(index, 1)
      }
    }
  }

  return kept
}

export function summarizeProcessing(raw: RawDetection[], processed: ProcessedDetection[]) {
  return {
    rawCount: raw.length,
    processedCount: processed.length,
    removedCount: raw.length - processed.length,
  }
}
