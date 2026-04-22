export interface InventorySession {
  id: string
  created_at: string
}

export interface Photo {
  id: string
  session_id: string
  image_url: string
}

export interface FinalCount {
  id: string
  session_id: string
  product: string
  quantity: number
  section?: string
}

export interface Database {
  public: {
    Tables: {
      inventory_sessions: {
        Row: InventorySession
        Insert: Omit<InventorySession, 'id' | 'created_at'>
        Update: Partial<Omit<InventorySession, 'id'>>
      }
      photos: {
        Row: Photo
        Insert: Omit<Photo, 'id'>
        Update: Partial<Omit<Photo, 'id'>>
      }
      final_counts: {
        Row: FinalCount
        Insert: Omit<FinalCount, 'id'>
        Update: Partial<Omit<FinalCount, 'id'>>
      }
    }
  }
}
