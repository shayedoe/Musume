# Musume — Roboflow Annotation Guide

> Project: https://app.roboflow.com/bretts-workspace-ouus6/musume

## Class Strategy

This project uses **one class: `bottle`**.

We intentionally do *not* train Roboflow to distinguish between Tito's vs Grey
Goose vs Jameson etc. — there are too many near-identical products in our
catalog (430+ SKUs) and training a per-product detector would require tens of
thousands of annotations before it was useful.

Instead:

- **Roboflow** finds and counts *where* bottles are (bounding boxes).
- **The reference gallery + OpenAI vision** (in the Supabase edge function
  `vision-analyze`) identifies *which product* each bottle is by matching each
  crop against `bottle_references`.

Roboflow's job is purely detection. SKU naming is handled downstream.

## What counts as a "bottle"?

Draw a tight bounding box around **any glass or plastic container that holds
alcoholic or cocktail-ingredient liquid**. Include:

- Liquor bottles (1L, 750ml, 375ml, handles, miniatures)
- Wine bottles
- Beer bottles (but not cans — see below)
- Bitters bottles, cordial bottles, syrup bottles on the bar
- Vermouth / liqueur bottles
- Empty bottles still on the shelf

## What is NOT a bottle?

- **Cans** — aluminum cans are a different silhouette; we can add a `can`
  class later if needed
- **Kegs** — too different from bottles
- **Boxes** (cardboard wine boxes, etc.) — skip for now
- **Glassware / tumblers / coupes** — drink-service glasses, not inventory
- **Shakers, jiggers, tools** — bar tools are not bottles
- **Garnish trays, ice bins** — no

## How to draw good boxes

- **Tight**: hug the bottle silhouette. Don't leave huge whitespace around it.
- **Include the neck and cap** — the full bottle from base to top.
- **Visible portion only**: if a bottle is 80% occluded behind another one,
  draw a box around the visible portion. Don't invent what you can't see.
- **Overlapping boxes are fine**: if two bottles sit side-by-side with some
  label overlap, draw both boxes even if they intersect.
- **Tilted bottles**: axis-aligned box is fine — Roboflow doesn't support
  rotated boxes on the standard detection model. Box the bottle's bounding
  rectangle.

## Back-row bottles

If you can see **enough of the cap, neck, or silhouette to identify it as a
bottle**, label it. If all you can see is a sliver of glass between two
foreground bottles, skip it. Our goal is "every bottle a human counter would
include" — not "every molecule of glass".

## Volume / target dataset size

Minimum to start training a useful model:
- **30–50 annotated shelf photos**
- **500+ total bottle instances** across all images
- Variety: different lighting, different sections of the bar, different
  densities, front/side angles

For a great model:
- **150+ annotated photos**
- **2000+ instances**

## Annotation workflow tips

1. In the Annotate tab, pick any unannotated image.
2. Type `bottle` as the label. Roboflow creates the class on first use — no
   pre-setup needed.
3. Use **Label Assist** (right sidebar, after ~20 annotations Roboflow starts
   suggesting boxes) to 3–5× your speed.
4. Use **Smart Polygon** for quick tight boxes — click a bottle, it detects
   edges. Then the tool converts to a bounding box.
5. Keyboard: `B` selects the box tool. `Enter` confirms a box. `A` / `D`
   navigates images.

## Training

1. Go to **Generate** → accept default 70/20/10 train/valid/test split.
2. Augmentations: enable **Horizontal Flip**, **Brightness ±25%**,
   **Blur 1–2px**, **Noise 2%**. Skip vertical flip (bottles are upright).
3. Resize: 640×640 or 800×800 (Stretch to).
4. Go to **Versions** → **Train** → **Roboflow 3.0 Object Detection (Fast)**.
5. Wait for training to finish (usually 15–30 minutes).

## Deploy

Once trained, copy the model ID (format: `musume/<version>`, e.g. `musume/1`).
Set it as a Supabase secret:

```powershell
$env:Path = "$HOME\scoop\shims;$env:Path"
$env:SUPABASE_ACCESS_TOKEN = "<YOUR_SUPABASE_PERSONAL_ACCESS_TOKEN>"
supabase secrets set ROBOFLOW_MODEL=musume/1 --project-ref <YOUR_PROJECT_REF>
```

The edge function `vision-analyze` auto-routes to Roboflow on next request.
No redeploy needed.

> ⚠️ Never commit a real `SUPABASE_ACCESS_TOKEN` (`sbp_*`) or any
> `SUPABASE_SERVICE_ROLE_KEY` to git. If you have, rotate it immediately at
> https://supabase.com/dashboard/account/tokens.

## Tuning (once you're running)

All configurable via Supabase secrets:

| Secret                | Default | What it does                                           |
| --------------------- | ------- | ------------------------------------------------------ |
| `ROBOFLOW_MODEL`      | unset   | `<project>/<version>`. Unset = fall back to OpenAI.    |
| `ROBOFLOW_CONFIDENCE` | `0.62`  | Min confidence to keep a box. Raise to cut false pos.  |
| `ROBOFLOW_OVERLAP`    | `0.22`  | NMS overlap threshold. Lower = more aggressive dedupe. |

## Retraining

As the app collects new shelf photos, periodically:

1. Download a sample from the `inventory-images` Supabase bucket.
2. Upload into Roboflow.
3. Annotate, generate a new version, retrain.
4. Update `ROBOFLOW_MODEL` secret to the new version.

A retrain every 2–4 weeks while the app is new is a good cadence.
