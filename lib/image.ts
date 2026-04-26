import * as ImageManipulator from 'expo-image-manipulator'

export interface ImageResult {
  uri: string
  base64: string
}

/**
 * Re-encode any image URI to a resized JPEG and return its base64 string.
 * Max width 900 px, 80 % quality — good balance of detail vs upload size.
 */
export async function toJpeg(uri: string): Promise<ImageResult> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 900 } }],
    { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true }
  )
  return { uri: result.uri, base64: result.base64 ?? '' }
}

/**
 * Decode a bare base64 string (or a data-URI) to a Uint8Array.
 * Avoids the broken React-Native `fetch('data:…').blob()` path on iOS.
 */
export function base64ToUint8Array(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lookup = new Uint8Array(256)
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i
  const clean = b64.replace(/^data:.*?;base64,/, '').replace(/\s+/g, '')
  let padding = 0
  if (clean.endsWith('==')) padding = 2
  else if (clean.endsWith('=')) padding = 1
  const byteLen = (clean.length * 3) / 4 - padding
  const bytes = new Uint8Array(byteLen)
  let p = 0
  for (let i = 0; i < clean.length; i += 4) {
    const e1 = lookup[clean.charCodeAt(i)]
    const e2 = lookup[clean.charCodeAt(i + 1)]
    const e3 = lookup[clean.charCodeAt(i + 2)]
    const e4 = lookup[clean.charCodeAt(i + 3)]
    if (p < byteLen) bytes[p++] = (e1 << 2) | (e2 >> 4)
    if (p < byteLen) bytes[p++] = ((e2 & 15) << 4) | (e3 >> 2)
    if (p < byteLen) bytes[p++] = ((e3 & 3) << 6) | (e4 & 63)
  }
  return bytes
}
