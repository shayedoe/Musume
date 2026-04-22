import { createClient } from '@supabase/supabase-js'
import Constants from 'expo-constants'
import { Database } from './types'

const supabaseUrl = Constants.expoConfig?.extra?.supabaseUrl
const supabaseAnonKey = Constants.expoConfig?.extra?.supabaseAnonKey

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase configuration in Expo config. Ensure expo.extra.supabaseUrl and expo.extra.supabaseAnonKey are defined.'
  )
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey)
