# Musume - Inventory Vision App

iOS inventory vision app that captures shelf photos, detects bottles, estimates counts + fill levels, and exports results to MarginEdge-compatible CSV.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Supabase

#### Create Storage Bucket

In your Supabase dashboard:
1. Go to Storage
2. Create a new bucket named `inventory-images`
3. Set it to **public** (or configure appropriate policies)

#### Create Database Tables

Run this SQL in the Supabase SQL Editor:

```sql
create table inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp default now()
);

create table photos (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references inventory_sessions(id) on delete cascade,
  image_url text not null
);

create table final_counts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references inventory_sessions(id) on delete cascade,
  product text,
  quantity decimal,
  section text
);

create index photos_session_id_idx on photos(session_id);
create index final_counts_session_id_idx on final_counts(session_id);

alter table inventory_sessions enable row level security;
alter table photos enable row level security;
alter table final_counts enable row level security;

create policy "Allow authenticated users to access inventory_sessions"
  on inventory_sessions
  for all
  to authenticated
  using (true)
  with check (true);

create policy "Allow authenticated users to access photos"
  on photos
  for all
  to authenticated
  using (true)
  with check (true);

create policy "Allow authenticated users to access final_counts"
  on final_counts
  for all
  to authenticated
  using (true)
  with check (true);
```

#### Update Configuration

In `app.json`, update the Supabase keys:

```json
"extra": {
  "supabaseUrl": "YOUR_SUPABASE_URL",
  "supabaseAnonKey": "YOUR_SUPABASE_ANON_KEY"
}
```

### 3. Initialize EAS (for TestFlight deployment)

```bash
eas init
```

Then update `app.json` with your EAS project ID:

```json
"extra": {
  "eas": {
    "projectId": "YOUR_EAS_PROJECT_ID"
  }
}
```

## Development

### Run on iOS Simulator

```bash
npm run ios
```

### Run with Expo Go

```bash
npm start
```

## Deployment

### Build for TestFlight

```bash
eas build -p ios
eas submit -p ios
```

Or use the combined command:

```bash
npx testflight
```

## Features

### Phase 1 - Core Functionality (Current)

- ✅ Camera screen with image capture
- ✅ Upload images to Supabase storage
- ✅ Create inventory sessions
- ✅ Review screen with manual input
- ✅ CSV export functionality

### Phase 2 - AI Integration (Coming Soon)

- YOLO bottle detection
- OCR label reading
- CLIP image similarity
- Fill level estimation

### Phase 3 - Optimization (Future)

- Multi-angle deduplication
- Faster review UI
- SKU accuracy improvements

## Usage

1. **Start Session**: Open the app and tap "Start Session"
2. **Capture Photo**: Take a photo of your inventory shelf
3. **Review & Count**: Manually enter product names, quantities, and sections
4. **Save**: Save counts to the database
5. **Export**: Export to MarginEdge-compatible CSV

## Architecture

```
Expo App
  ↓
Supabase Storage (images)
  ↓
Supabase DB (sessions + counts)
  ↓
Review UI
  ↓
CSV Export
```

## CSV Format

```csv
Product,Count,Unit,Section
Don Julio Blanco,2.5,bottle,Shelf A
Tito's Vodka,3,bottle,Shelf A
```

## License

MIT
