# Musume Setup Guide

This guide will walk you through setting up the Musume inventory vision app from scratch.

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- iOS device or simulator for testing
- Supabase account (free tier works)
- Expo account (optional, for EAS builds)

## Step 1: Clone and Install

```bash
git clone https://github.com/shayedoe/Musume.git
cd Musume
npm install
```

## Step 2: Set Up Supabase

### 2.1 Create a Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Sign up or log in
3. Create a new project
4. Wait for the project to be ready

### 2.2 Run Database Setup SQL

1. In your Supabase dashboard, go to the **SQL Editor**
2. Copy the contents of `supabase-setup.sql` from this repository
3. Paste it into the SQL Editor
4. Click **Run** to execute

This will create:
- `inventory_sessions` table
- `photos` table
- `products` table (bottle catalog)
- `detections` table (AI-proposed bottle detections)
- `final_counts` table
- Appropriate indexes and Row Level Security policies

### 2.3 Create Storage Bucket

1. In your Supabase dashboard, go to **Storage**
2. Click **New bucket**
3. Name it: `inventory-images`
4. Make it **public** (for development)
5. Click **Create bucket**

### 2.4 Get Your Supabase Credentials

1. In your Supabase dashboard, go to **Settings** > **API**
2. Copy the following:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **anon public key** (the long JWT token)

### 2.5 Update app.json

Edit `app.json` and replace the Supabase credentials:

```json
{
  "expo": {
    "extra": {
      "supabaseUrl": "YOUR_SUPABASE_URL_HERE",
      "supabaseAnonKey": "YOUR_SUPABASE_ANON_KEY_HERE",
      "visionEndpoint": "",
      "openaiApiKey": "",
      "eas": {
        "projectId": "REPLACE_WITH_EAS_PROJECT_ID"
      }
    }
  }
}
```

### 2.6 Configure the Vision Backend

The app sends each shelf photo to a vision model to detect bottles, count
duplicates, and estimate fill level. Pick ONE option:

**Option A – Your own vision endpoint (recommended for production).**
Set `extra.visionEndpoint` to a URL that accepts:

```json
POST { "image_base64": "...", "catalog": ["Tito's Vodka 750ml", ...] }
```

and returns:

```json
{ "detections": [ { "product": "...", "count": 1, "fill_level": 1, "confidence": 0.8, "barcode": null, "notes": "" } ], "warnings": [] }
```

Fill level must be one of `1` (full/unopened), `0.5` (about half),
`0.1` (nearly empty), or `0` (empty).

**Option B – OpenAI Vision (fastest to try).**
Set `extra.openaiApiKey` to an OpenAI API key. The app will call
`gpt-4o-mini` with the image directly. Note: embedding a key in a client
app is **not** safe for production; use Option A with a server proxy.

## Step 3: Test Locally

### Run on iOS Simulator

```bash
npm run ios
```

### Run with Expo Go

```bash
npm start
```

Then scan the QR code with your iPhone camera or Expo Go app.

## Step 4: Test the Flow

1. Open the app
2. Tap **Start Session – Take Photo** or **Start Session – Upload Photo**
3. Add one or more shelf photos (camera or gallery). You can upload a saved
   inventory photo to troubleshoot bottle detection.
4. Tap **Analyze N photos**. The app will:
   - Create a session
   - Send each image to your configured vision backend
   - Detect bottles, count duplicates, and estimate fill level (1 / 0.5 / 0.1)
   - Match detections to the product catalog
   - Save photos + detections to Supabase
5. On the **Review** screen you can:
   - Edit the AI-proposed product names
   - Fix the bottle count at each fill level
   - Change the fill bucket (Full / Half / Low / Empty)
   - Add missed bottles manually
6. Tap **Save Counts** to write `final_counts` (quantity = count × fill).
7. Tap **Export CSV** to export a MarginEdge-friendly CSV.

## Step 5: Verify Data in Supabase

1. Go to your Supabase dashboard
2. Click **Table Editor**
3. Check the tables:
   - `inventory_sessions` - should have a new session
   - `photos` - should have the uploaded image URL
   - `final_counts` - should have your manual counts
4. Go to **Storage** > `inventory-images` to see uploaded photos

## Step 6 (Optional): Deploy to TestFlight

### 6.1 Install EAS CLI

```bash
npm install -g eas-cli
```

### 6.2 Initialize EAS

```bash
eas login
eas init
```

Copy the Project ID and add it to `app.json`:

```json
"extra": {
  "eas": {
    "projectId": "YOUR_EAS_PROJECT_ID"
  }
}
```

### 6.3 Build for iOS

```bash
eas build -p ios
```

### 6.4 Submit to TestFlight

```bash
eas submit -p ios
```

Follow the prompts to complete the submission.

## Troubleshooting

### Camera Permission Issues

Make sure the iOS info plist permissions are set in `app.json`:

```json
"ios": {
  "infoPlist": {
    "NSCameraUsageDescription": "Use the camera to capture inventory shelf photos.",
    "NSPhotoLibraryUsageDescription": "Use the photo library to upload inventory shelf photos."
  }
}
```

### Supabase Connection Issues

1. Check that your `supabaseUrl` and `supabaseAnonKey` are correct
2. Verify the storage bucket `inventory-images` exists and is public
3. Check that RLS policies are set up correctly

### TypeScript Errors

```bash
npm run typecheck
```

Most errors related to missing types from `node_modules` can be ignored during development.

### Upload Failures

1. Check that the storage bucket is public
2. Verify you have the correct bucket name: `inventory-images`
3. Check Supabase logs in the dashboard

## Next Steps

Now that you have the basic app working, you can:

1. **Add AI Detection** - Implement YOLO for bottle detection
2. **Improve UI** - Add better styling and user feedback
3. **Add Authentication** - Secure the app with user accounts
4. **Multi-Angle Support** - Allow multiple photos per session
5. **Offline Support** - Cache data locally

## Support

For issues, please open a GitHub issue at: https://github.com/shayedoe/Musume/issues

## CSV Export Format

The exported CSV follows this format:

```csv
Product,Count,Unit,Section
Don Julio Blanco,2.5,bottle,Shelf A
Tito's Vodka,3.0,bottle,Shelf A
```

This format is compatible with MarginEdge inventory imports.
