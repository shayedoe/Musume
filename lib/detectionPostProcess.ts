export function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)

  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.area + b.area - inter

  return union === 0 ? 0 : inter / union
}

export function processDetections(detections, imgW, imgH) {
  const normalized = detections.map((d) => {
    const x1 = d.x - d.width / 2
    const y1 = d.y - d.height / 2
    const x2 = d.x + d.width / 2
    const y2 = d.y + d.height / 2

    return {
      ...d,
      x1,
      y1,
      x2,
      y2,
      area: d.width * d.height
    }
  })

  const filtered = normalized.filter((d) => {
    const aspect = d.height / d.width
    const relHeight = d.height / imgH

    return (
      d.confidence > 0.45 &&
      aspect > 1.4 &&
      relHeight > 0.12
    )
  })

  const sorted = filtered.sort((a, b) => b.confidence - a.confidence)
  const result = []

  while (sorted.length) {
    const current = sorted.shift()
    result.push(current)

    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(current, sorted[i]) > 0.5) {
        sorted.splice(i, 1)
      }
    }
  }

  return result
}
