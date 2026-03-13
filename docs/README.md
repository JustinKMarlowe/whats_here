# What's Here

**Discover open-source geodata available at your current location.**

A mobile-friendly web app that uses your device's GPS to identify and catalog all the open-source geospatial data that exists where you currently are — coordinate reference systems, datums, ellipsoids, geoid models, satellite imagery, elevation data, and feature layers like parcels and hydrology.

## Live Site

Deploy via GitHub Pages from the `main` branch, or open `index.html` directly in a browser.

## What It Shows

When you tap **"What's Here"**, the app acquires your location and displays:

| Category | Examples |
|---|---|
| **Geographic CRS** | WGS 84 (EPSG:4326), NAD83 (EPSG:4269), etc. |
| **Projected CRS** | UTM zones, State Plane systems (SPCS), national grids |
| **Datums** | WGS 84, NAD83, NAD27, local vertical datums |
| **Ellipsoids** | WGS 84, GRS 1980, Clarke 1866 |
| **Geoid Models** | EGM2008, GEOID18, regional models |
| **Imagery & Elevation** | Sentinel-2, Landsat, NAIP, SRTM, 3DEP |
| **Feature Layers** | OSM, Census TIGER, NHD, FEMA NFHL, parcels |

All data entries include EPSG codes (where applicable), full names, descriptions, and direct links to the source.

## How It Works

1. **Geolocation API** — requests your device's GPS coordinates
2. **Nominatim** (OpenStreetMap) — reverse geocodes to determine country, state, and county
3. **EPSG.io** — queries for coordinate reference systems, datums, and ellipsoids applicable to your area
4. **Curated catalog** — matches your location against a built-in catalog of open-source imagery, elevation, geoid models, and feature layer services

All API calls happen client-side. No backend, no accounts, no tracking.

## Deployment

This is a static site — three files, no build step:

```
index.html
css/style.css
js/app.js
```

### GitHub Pages
1. Push to the `main` branch of your repository
2. Go to **Settings → Pages**
3. Set source to **Deploy from a branch** → `main` → `/ (root)`
4. Your site will be live at `https://justinkmarlowe.github.io/whats_here/`

### Any static host
Upload the three files (preserving the `css/` and `js/` directory structure) to any web server or static hosting service (Netlify, Vercel, Cloudflare Pages, etc.).

## Browser Support

Requires a browser with Geolocation API support (all modern mobile and desktop browsers). HTTPS is required for geolocation on most browsers — GitHub Pages provides this automatically.

## Data Sources & APIs

| Service | Use | CORS |
|---|---|---|
| [Nominatim](https://nominatim.openstreetmap.org/) | Reverse geocoding | ✅ |
| [EPSG.io](https://epsg.io/) | CRS / datum / ellipsoid lookup | ✅ |
| Various (USGS, ESA, Census, etc.) | Linked as data sources | N/A (links only) |

## License

MIT
