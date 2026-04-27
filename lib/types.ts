export interface InventorySession {
  id: string
  created_at: string
  location_name?: string | null
  count_sheet_name?: string | null
  status?: 'open' | 'reviewed' | 'exported' | null
}

export interface Photo {
  id: string
  session_id: string
  image_url: string
  captured_at?: string | null
}

export interface Product {
  id: string
  name: string
  count_unit: string
  bottle_size_ml?: number | null
  barcode?: string | null
  aliases?: string[] | null
  marginedge_product_id?: string | null
  active?: boolean | null
  unit_price?: number | null
}

export type FillLevel = 1 | 0.5 | 0.1 | 0

export interface Detection {
  id: string
  photo_id: string
  session_id: string
  predicted_product?: string | null
  matched_product_id?: string | null
  count: number
  fill_level: FillLevel
  confidence?: number | null
  notes?: string | null
  status?: 'pending' | 'confirmed' | 'rejected' | null
}

export interface FinalCount {
  id: string
  session_id: string
  product: string
  product_id?: string | null
  quantity: number
  section?: string | null
}

export interface VisionDetectionResult {
  product: string
  count: number
  fill_level: FillLevel
  confidence?: number
  notes?: string
  barcode?: string | null
}

export interface BottleAnnotation {
  bbox: [number, number, number, number] // normalized [x, y, w, h] in [0,1]
  product: string
  status: 'matched' | 'identified' | 'unknown'
  confidence: number
  // Optional segmentation polygon (e.g. SAM3 mask), normalized 0..1.
  polygon?: Array<[number, number]>
}

export interface VisionAnalysisResponse {
  detections: VisionDetectionResult[]
  annotations?: BottleAnnotation[]
  warnings?: string[]
  meta?: Record<string, unknown>
  // Roboflow's server-rendered overlay image (bboxes + labels already drawn).
  // When present, the app shows this directly instead of drawing its own overlays.
  visual_overlay?: string
}

export interface Database {
  public: {
    Tables: {
      inventory_sessions: {
        Row: InventorySession
        Insert: Partial<Omit<InventorySession, 'id' | 'created_at'>>
        Update: Partial<Omit<InventorySession, 'id'>>
      }
      photos: {
        Row: Photo
        Insert: Omit<Photo, 'id' | 'captured_at'> & { captured_at?: string }
        Update: Partial<Omit<Photo, 'id'>>
      }
      products: {
        Row: Product
        Insert: Omit<Product, 'id'>
        Update: Partial<Omit<Product, 'id'>>
      }
      detections: {
        Row: Detection
        Insert: Omit<Detection, 'id'>
        Update: Partial<Omit<Detection, 'id'>>
      }
      final_counts: {
        Row: FinalCount
        Insert: Omit<FinalCount, 'id'>
        Update: Partial<Omit<FinalCount, 'id'>>
      }
    }
  }
}
