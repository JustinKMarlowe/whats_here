/* ═══════════════════════════════════════════════════════
   What's Here — Application Logic
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── DOM refs ────────────────────────────────────────
  const $landing  = document.getElementById('screen-landing');
  const $loading  = document.getElementById('screen-loading');
  const $results  = document.getElementById('screen-results');
  const $errorOvl = document.getElementById('error-overlay');

  const $btnStart   = document.getElementById('btn-whats-here');
  const $btnBack    = document.getElementById('btn-back');
  const $btnRefresh = document.getElementById('btn-refresh');
  const $btnError   = document.getElementById('btn-error-dismiss');

  const $loadStatus = document.getElementById('loading-status');
  const $loadBar    = document.getElementById('loading-bar');
  const $coords     = document.getElementById('results-coords');
  const $locName    = document.getElementById('location-name');
  const $body       = document.getElementById('results-body');

  // ── State ───────────────────────────────────────────
  let currentLat = null;
  let currentLon = null;

  // ── Navigation ──────────────────────────────────────
  function showScreen(screen) {
    [$landing, $loading, $results].forEach(s => s.classList.remove('active'));
    screen.classList.add('active');
    window.scrollTo(0, 0);
  }

  function showError(title, message) {
    document.getElementById('error-title').textContent = title;
    document.getElementById('error-message').textContent = message;
    $errorOvl.classList.remove('hidden');
  }

  // ── Event Wiring ────────────────────────────────────
  $btnStart.addEventListener('click', startDiscovery);
  $btnBack.addEventListener('click', () => showScreen($landing));
  $btnRefresh.addEventListener('click', startDiscovery);
  $btnError.addEventListener('click', () => {
    $errorOvl.classList.add('hidden');
    showScreen($landing);
  });

  // ── Main Flow ───────────────────────────────────────
  async function startDiscovery() {
    showScreen($loading);
    setProgress(5, 'Acquiring location…');

    try {
      const pos = await getLocation();
      currentLat = pos.coords.latitude;
      currentLon = pos.coords.longitude;

      setProgress(15, 'Location acquired — querying geodata…');

      const results = await gatherGeodata(currentLat, currentLon);

      renderResults(currentLat, currentLon, results);
      showScreen($results);

    } catch (err) {
      console.error(err);
      showScreen($landing);
      if (err.code === 1) {
        showError('Permission Denied', 'Location access was denied. Please allow location permissions in your browser settings and try again.');
      } else if (err.code === 2) {
        showError('Position Unavailable', 'Your device could not determine its location. Please try again or check your GPS/network settings.');
      } else if (err.code === 3) {
        showError('Request Timed Out', 'Location request timed out. Please make sure you have a GPS signal or network connection and try again.');
      } else {
        showError('Something Went Wrong', err.message || 'An unexpected error occurred while gathering geodata. Please try again.');
      }
    }
  }

  function setProgress(pct, msg) {
    $loadBar.style.width = pct + '%';
    if (msg) $loadStatus.textContent = msg;
  }

  // ── Geolocation ─────────────────────────────────────
  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported by your browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000
      });
    });
  }

  // ── Data Gathering ──────────────────────────────────
  async function gatherGeodata(lat, lon) {
    const results = {
      location: null,
      geographicCRS: [],
      projectedCRS: [],
      datums: [],
      ellipsoids: [],
      geoids: [],
      imagery: [],
      featureLayers: []
    };

    // Step 1 — Reverse geocode
    setProgress(20, 'Reverse geocoding…');
    try {
      results.location = await reverseGeocode(lat, lon);
    } catch (e) {
      console.warn('Reverse geocode failed:', e);
      results.location = { display: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, country: '', state: '', county: '', countryCode: '' };
    }

    // Step 2 — EPSG / CRS data
    setProgress(35, 'Querying coordinate reference systems…');
    try {
      const crsData = await queryEPSG(lat, lon, results.location);
      results.geographicCRS = crsData.geographic;
      results.projectedCRS  = crsData.projected;
      results.datums        = crsData.datums;
      results.ellipsoids    = crsData.ellipsoids;
    } catch (e) {
      console.warn('EPSG query failed:', e);
    }

    // Step 3 — Geoid models
    setProgress(55, 'Identifying geoid models…');
    results.geoids = getGeoidModels(lat, lon, results.location.countryCode);

    // Step 4 — Imagery sources
    setProgress(70, 'Cataloging available imagery…');
    results.imagery = getImagerySources(lat, lon, results.location);

    // Step 5 — Feature layers
    setProgress(85, 'Discovering feature layers…');
    results.featureLayers = getFeatureLayers(lat, lon, results.location);

    setProgress(100, 'Done!');
    return results;
  }

  // ── Reverse Geocode (Nominatim) ─────────────────────
  async function reverseGeocode(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1`;
    const resp = await fetchJSON(url, { 'Accept-Language': 'en' });
    const addr = resp.address || {};
    return {
      display: resp.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      country: addr.country || '',
      countryCode: (addr.country_code || '').toUpperCase(),
      state: addr.state || addr.region || '',
      county: addr.county || addr.city || addr.town || '',
      city: addr.city || addr.town || addr.village || ''
    };
  }

  // ── EPSG.io Queries ─────────────────────────────────
  async function queryEPSG(lat, lon, loc) {
    const geographic = [];
    const projected  = [];
    const datums     = [];
    const ellipsoids = [];

    // Build search terms based on location context
    const searchTerms = buildSearchTerms(lat, lon, loc);

    // Query EPSG.io for each search term
    const allResults = [];
    for (const term of searchTerms) {
      try {
        const url = `https://epsg.io/?q=${encodeURIComponent(term)}&format=json&trans=0`;
        const data = await fetchJSON(url);
        if (data && data.results) {
          allResults.push(...data.results);
        }
      } catch (e) {
        console.warn(`EPSG search failed for "${term}":`, e);
      }
    }

    // Deduplicate by code
    const seen = new Set();
    const unique = allResults.filter(r => {
      if (seen.has(r.code)) return false;
      seen.add(r.code);
      return true;
    });

    // Categorize
    for (const r of unique) {
      const entry = {
        code: `EPSG:${r.code}`,
        name: r.name,
        area: r.area || '',
        accuracy: r.accuracy,
        kind: r.kind,
        deprecated: r.deprecated || false,
        link: `https://epsg.io/${r.code}`
      };

      if (entry.deprecated) continue;

      switch (r.kind) {
        case 'CRS-GEOGCRS':
        case 'CRS-GEOG3DCRS':
          geographic.push(entry);
          break;
        case 'CRS-PROJCRS':
          projected.push(entry);
          break;
        case 'DATUM':
        case 'DATUM-GEODETIC':
        case 'DATUM-VERTICAL':
        case 'DATUM-ENGINEERING':
          datums.push(entry);
          break;
        case 'ELLIPSOID':
          ellipsoids.push(entry);
          break;
      }
    }

    // Always include the universal ones at the top if not already present
    ensureEntry(geographic, 'EPSG:4326', 'WGS 84', 'CRS-GEOGCRS', 'World');
    ensureEntry(geographic, 'EPSG:4979', 'WGS 84 (3D)', 'CRS-GEOG3DCRS', 'World');
    ensureEntry(datums, 'EPSG:6326', 'World Geodetic System 1984', 'DATUM', 'World');
    ensureEntry(ellipsoids, 'EPSG:7030', 'WGS 84 (ellipsoid)', 'ELLIPSOID', 'World');

    // Add UTM zone
    const utmZone = getUTMZone(lat, lon);
    if (utmZone) {
      ensureEntry(projected, utmZone.code, utmZone.name, 'CRS-PROJCRS', utmZone.area);
    }

    // Sort: most specific/local first
    const sortByRelevance = (a, b) => {
      if (a.area === 'World' && b.area !== 'World') return 1;
      if (a.area !== 'World' && b.area === 'World') return -1;
      return a.name.localeCompare(b.name);
    };
    geographic.sort(sortByRelevance);
    projected.sort(sortByRelevance);
    datums.sort(sortByRelevance);

    return { geographic, projected, datums, ellipsoids };
  }

  function buildSearchTerms(lat, lon, loc) {
    const terms = [];

    // Country-level
    if (loc.countryCode === 'US') {
      terms.push('NAD83');
      terms.push('NAD27');
      if (loc.state) {
        // State plane coordinate systems
        terms.push(`NAD83 ${loc.state}`);
        terms.push(`SPCS ${loc.state}`);
        // State-specific
        const stateAbbr = usStateAbbr(loc.state);
        if (stateAbbr) {
          terms.push(`NAD83 / ${loc.state}`);
        }
      }
    } else if (loc.countryCode) {
      terms.push(loc.country);
      if (loc.state) terms.push(loc.state);
    }

    // UTM zone search
    const utmNum = Math.floor((lon + 180) / 6) + 1;
    const hemi = lat >= 0 ? 'N' : 'S';
    terms.push(`UTM zone ${utmNum}${hemi}`);

    // WGS 84 / global
    terms.push('WGS 84');

    return terms;
  }

  function ensureEntry(arr, code, name, kind, area) {
    if (!arr.find(e => e.code === code)) {
      arr.unshift({
        code, name, area: area || '', kind,
        deprecated: false,
        link: `https://epsg.io/${code.replace('EPSG:', '')}`
      });
    }
  }

  function getUTMZone(lat, lon) {
    const zone = Math.floor((lon + 180) / 6) + 1;
    const hemi = lat >= 0 ? 'N' : 'S';
    const epsgBase = lat >= 0 ? 32600 : 32700;
    const code = `EPSG:${epsgBase + zone}`;
    return {
      code,
      name: `WGS 84 / UTM zone ${zone}${hemi}`,
      area: `UTM Zone ${zone}${hemi}`
    };
  }

  // ── Geoid Models ────────────────────────────────────
  function getGeoidModels(lat, lon, countryCode) {
    const models = [];

    // Global models
    models.push({
      name: 'EGM2008',
      code: 'EGM2008',
      description: 'Earth Gravitational Model 2008 — the current global standard geoid at ~2.5\' resolution (~5 km). Maintained by NGA.',
      link: 'https://earth-info.nga.mil/GandG/wgs84/gravitymod/egm2008/',
      tags: ['global', 'gravity', 'NGA']
    });
    models.push({
      name: 'EGM96',
      code: 'EGM96',
      description: 'Earth Gravitational Model 1996 — predecessor to EGM2008, still widely used in legacy systems. 15\' resolution.',
      link: 'https://earth-info.nga.mil/GandG/wgs84/gravitymod/egm96/',
      tags: ['global', 'gravity', 'legacy']
    });
    models.push({
      name: 'EGM84',
      code: 'EGM84',
      description: 'Earth Gravitational Model 1984 — original WGS 84 geoid model. Historical reference only.',
      link: 'https://earth-info.nga.mil/GandG/wgs84/gravitymod/',
      tags: ['global', 'historical']
    });

    // US-specific
    if (countryCode === 'US') {
      models.push({
        name: 'GEOID18',
        code: 'GEOID18',
        description: 'NGS hybrid geoid model (2018) for CONUS, relating NAD 83 ellipsoid heights to NAVD 88 orthometric heights. ~1 cm accuracy.',
        link: 'https://geodesy.noaa.gov/GEOID/GEOID18/',
        tags: ['US', 'NGS', 'NAD83', 'NAVD88']
      });
      models.push({
        name: 'GEOID12B',
        code: 'GEOID12B',
        description: 'Earlier NGS hybrid geoid model superseded by GEOID18. Still common in archived survey data.',
        link: 'https://geodesy.noaa.gov/GEOID/GEOID12B/',
        tags: ['US', 'NGS', 'legacy']
      });
      models.push({
        name: 'xGEOID20',
        code: 'xGEOID20',
        description: 'Experimental NGS geoid model (2020) — precursor to the upcoming North American-Pacific Geopotential Datum (NAPGD2022).',
        link: 'https://geodesy.noaa.gov/GEOID/',
        tags: ['US', 'NGS', 'experimental']
      });
    }

    // Canada
    if (countryCode === 'CA') {
      models.push({
        name: 'CGG2013a',
        code: 'CGG2013a',
        description: 'Canadian Gravimetric Geoid 2013a — NRCan geoid model for use with NAD83(CSRS) and CGVD2013.',
        link: 'https://www.nrcan.gc.ca/maps-tools-and-publications/tools/geodetic-reference-systems/9054',
        tags: ['Canada', 'NRCan', 'CGVD2013']
      });
    }

    // Europe
    if (['GB', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'AT', 'CH', 'PL', 'CZ', 'SE', 'NO', 'FI', 'DK'].includes(countryCode)) {
      models.push({
        name: 'EGG2015',
        code: 'EGG2015',
        description: 'European Gravimetric Geoid 2015 — high-resolution quasi-geoid for Europe. Supports EVRS/EVRF height systems.',
        link: 'https://www.isgeoid.polimi.it/Geoid/Europe/europe.html',
        tags: ['Europe', 'EVRS']
      });
    }

    // Australia
    if (countryCode === 'AU') {
      models.push({
        name: 'AUSGeoid2020',
        code: 'AUSGeoid2020',
        description: 'Australian national geoid model for converting GDA2020 ellipsoidal heights to AHD71 orthometric heights.',
        link: 'https://www.ga.gov.au/scientific-topics/positioning-navigation/geodesy/geodetic-datums/ausgeoid',
        tags: ['Australia', 'GA', 'GDA2020']
      });
    }

    return models;
  }

  // ── Imagery Sources ─────────────────────────────────
  function getImagerySources(lat, lon, loc) {
    const sources = [];

    // Global sources
    sources.push({
      name: 'Sentinel-2 L2A',
      provider: 'ESA / Copernicus',
      description: 'Multispectral imagery at 10 m resolution, ~5-day revisit. Free and open via Copernicus Open Access Hub. Bands: visible, NIR, SWIR.',
      link: 'https://dataspace.copernicus.eu/',
      tags: ['10m', 'multispectral', 'global', '5-day revisit'],
      wms: 'https://services.sentinel-hub.com/ogc/wms/'
    });
    sources.push({
      name: 'Landsat 8/9 Collection 2',
      provider: 'USGS / NASA',
      description: 'Multispectral + thermal imagery at 30 m (15 m pan), 16-day revisit. Freely available through USGS EarthExplorer and Google Earth Engine.',
      link: 'https://earthexplorer.usgs.gov/',
      tags: ['30m', 'multispectral', 'thermal', 'global', '16-day revisit']
    });
    sources.push({
      name: 'OpenStreetMap Tiles',
      provider: 'OpenStreetMap Foundation',
      description: 'Community-maintained street-level map tiles. Vector and raster formats via multiple tile servers.',
      link: 'https://www.openstreetmap.org/',
      tags: ['basemap', 'vector', 'global', 'community']
    });
    sources.push({
      name: 'SRTM (Shuttle Radar Topography)',
      provider: 'NASA / USGS',
      description: 'Global elevation data at ~30 m (1 arc-second) resolution between 60°N and 56°S. Void-filled version available.',
      link: 'https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm-1',
      tags: ['DEM', '30m', 'elevation', 'global']
    });
    sources.push({
      name: 'Copernicus DEM (GLO-30)',
      provider: 'ESA / Airbus',
      description: 'Global 30 m digital elevation model derived from TanDEM-X radar. Higher quality than SRTM in many areas.',
      link: 'https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model',
      tags: ['DEM', '30m', 'elevation', 'global', 'radar']
    });
    sources.push({
      name: 'MODIS (Terra & Aqua)',
      provider: 'NASA',
      description: 'Daily global coverage at 250 m – 1 km resolution. 36 spectral bands useful for land cover, vegetation, fire, and atmospheric studies.',
      link: 'https://modis.gsfc.nasa.gov/',
      tags: ['250m–1km', 'daily', 'global', 'land cover']
    });

    // US-specific
    if (loc.countryCode === 'US') {
      sources.push({
        name: 'NAIP (National Agriculture Imagery Program)',
        provider: 'USDA',
        description: 'Sub-meter (60 cm) aerial imagery covering the continental US. Natural color + NIR. Updated on a ~2-3 year cycle per state.',
        link: 'https://naip-usdaonline.hub.arcgis.com/',
        tags: ['0.6m', 'aerial', 'RGBIR', 'US', 'USDA'],
        wms: 'https://gis.apfo.usda.gov/arcgis/services/NAIP/USDA_CONUS_PRIME/ImageServer/WMSServer'
      });
      sources.push({
        name: 'USGS 3DEP Elevation (1/3 arc-second)',
        provider: 'USGS',
        description: 'High-resolution (~10 m) seamless elevation data for the US. Includes LiDAR-derived DEMs where available.',
        link: 'https://www.usgs.gov/3d-elevation-program',
        tags: ['DEM', '10m', 'LiDAR', 'US'],
        wms: 'https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer'
      });
      sources.push({
        name: 'USGS Topo Maps (US Topo & HTMC)',
        provider: 'USGS',
        description: 'Current US Topo (GeoPDF) and Historical Topographic Map Collection — digital and scanned 7.5-minute quads.',
        link: 'https://www.usgs.gov/programs/national-geospatial-program/topographic-maps',
        tags: ['topo', 'basemap', 'US', 'historical']
      });
      sources.push({
        name: 'USGS National Land Cover Database (NLCD)',
        provider: 'USGS / MRLC',
        description: 'Land cover classification at 30 m resolution for the US. Categories include developed, forest, agriculture, water, wetlands, etc.',
        link: 'https://www.mrlc.gov/',
        tags: ['30m', 'land cover', 'classification', 'US']
      });
    }

    // Europe
    if (['GB', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'AT', 'CH', 'PL', 'CZ', 'SE', 'NO', 'FI', 'DK', 'IE', 'PT'].includes(loc.countryCode)) {
      sources.push({
        name: 'CORINE Land Cover',
        provider: 'EEA / Copernicus',
        description: 'Pan-European land cover/land use data at 100 m resolution. 44 thematic classes updated every ~6 years.',
        link: 'https://land.copernicus.eu/pan-european/corine-land-cover',
        tags: ['100m', 'land cover', 'Europe']
      });
    }

    // Australia
    if (loc.countryCode === 'AU') {
      sources.push({
        name: 'Digital Earth Australia',
        provider: 'Geoscience Australia',
        description: 'Analysis-ready Landsat and Sentinel-2 data for all of Australia via Open Data Cube. Includes derivative products.',
        link: 'https://www.dea.ga.gov.au/',
        tags: ['multispectral', 'analysis-ready', 'Australia']
      });
    }

    return sources;
  }

  // ── Feature Layers ──────────────────────────────────
  function getFeatureLayers(lat, lon, loc) {
    const layers = [];

    // Global layers
    layers.push({
      name: 'OpenStreetMap',
      provider: 'OSM Community',
      description: 'Global crowd-sourced vector data: roads, buildings, land use, POIs, boundaries, water bodies, and more. Accessible via Overpass API or bulk downloads.',
      link: `https://www.openstreetmap.org/#map=14/${lat.toFixed(4)}/${lon.toFixed(4)}`,
      tags: ['global', 'vector', 'community', 'ODbL'],
      api: 'https://overpass-api.de/api/interpreter'
    });
    layers.push({
      name: 'Natural Earth',
      provider: 'Natural Earth Data',
      description: 'Public domain vector and raster data at 1:10m, 1:50m, and 1:110m scales. Cultural and physical features worldwide — borders, populated places, rivers, lakes, land cover.',
      link: 'https://www.naturalearthdata.com/',
      tags: ['global', 'basemap', 'public domain', 'small-scale']
    });
    layers.push({
      name: 'Global Administrative Areas (GADM)',
      provider: 'GADM',
      description: 'Administrative boundary polygons for every country at multiple levels (country, state/province, county/district, etc.).',
      link: 'https://gadm.org/',
      tags: ['global', 'boundaries', 'administrative']
    });

    // US-specific
    if (loc.countryCode === 'US') {
      layers.push({
        name: 'US Census TIGER/Line',
        provider: 'U.S. Census Bureau',
        description: 'Official boundary and road shapefiles for the US — states, counties, tracts, block groups, roads, water features, tribal areas, congressional districts.',
        link: 'https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html',
        tags: ['US', 'boundaries', 'roads', 'census'],
        wfs: 'https://tigerweb.geo.census.gov/arcgis/services/TIGERweb/tigerWMS_Current/MapServer/WFSServer'
      });
      layers.push({
        name: 'National Hydrography Dataset (NHD)',
        provider: 'USGS',
        description: 'Comprehensive hydrography: streams, rivers, lakes, ponds, coastline, dams, and stream gauges across the US.',
        link: 'https://www.usgs.gov/national-hydrography/national-hydrography-dataset',
        tags: ['US', 'hydrology', 'water', 'USGS'],
        wfs: 'https://hydro.nationalmap.gov/arcgis/services/nhd/MapServer/WFSServer'
      });
      layers.push({
        name: 'National Wetlands Inventory (NWI)',
        provider: 'USFWS',
        description: 'Wetland and deepwater habitat polygons classified by the Cowardin system. Includes type, regime, and special modifiers.',
        link: 'https://www.fws.gov/program/national-wetlands-inventory',
        tags: ['US', 'wetlands', 'habitat', 'USFWS'],
        wms: 'https://www.fws.gov/wetlands/arcgis/services/Wetlands/MapServer/WMSServer'
      });
      layers.push({
        name: 'FEMA National Flood Hazard Layer (NFHL)',
        provider: 'FEMA',
        description: 'Flood hazard zones, base flood elevations, and floodway boundaries. Used for insurance rate maps (FIRMs).',
        link: 'https://www.fema.gov/flood-maps/national-flood-hazard-layer',
        tags: ['US', 'flood zones', 'hazard', 'FEMA'],
        wms: 'https://hazards.fema.gov/gis/nfhl/services/public/NFHL/MapServer/WMSServer'
      });
      layers.push({
        name: 'Protected Areas (PAD-US)',
        provider: 'USGS GAP',
        description: 'Inventory of protected lands in the US — national parks, forests, wilderness, conservation easements, state lands, and more.',
        link: 'https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview',
        tags: ['US', 'protected areas', 'parks', 'conservation']
      });
      layers.push({
        name: 'Parcel / Cadastral Data',
        provider: 'Varies by county',
        description: 'Property parcel boundaries with owner names, assessed values, and legal descriptions. Open availability varies by state/county. Regrid (formerly Loveland) aggregates nationwide open parcel data.',
        link: 'https://app.regrid.com/',
        tags: ['US', 'parcels', 'property', 'cadastral', 'varies by county']
      });
      layers.push({
        name: 'US Structures (Microsoft / OpenStreetMap)',
        provider: 'Microsoft AI / OSM',
        description: 'AI-derived building footprints covering the entire US (~130M buildings). Released under ODbL license. Many are merged into OSM.',
        link: 'https://github.com/microsoft/USBuildingFootprints',
        tags: ['US', 'buildings', 'footprints', 'AI-derived']
      });

      // State-level parcel info
      if (loc.state) {
        const parcelInfo = getStateParcelInfo(loc.state);
        if (parcelInfo) {
          layers.push(parcelInfo);
        }
      }
    }

    // Canada
    if (loc.countryCode === 'CA') {
      layers.push({
        name: 'CanVec / National Topographic Data',
        provider: 'NRCan',
        description: 'Canadian topographic vector data — transport, hydro, land cover, administrative boundaries at multiple scales.',
        link: 'https://open.canada.ca/data/en/dataset/8ba2aa2a-7bb9-4571-99e8-9f31f99c7c43',
        tags: ['Canada', 'topo', 'vector', 'NRCan']
      });
    }

    // UK
    if (loc.countryCode === 'GB') {
      layers.push({
        name: 'OS Open Data',
        provider: 'Ordnance Survey',
        description: 'Open vector and raster products for Great Britain: roads, greenspaces, boundaries, terrain, rivers, buildings (OpenMap Local).',
        link: 'https://www.ordnancesurvey.co.uk/products/os-open-data',
        tags: ['UK', 'OS', 'boundaries', 'roads']
      });
    }

    // Australia
    if (loc.countryCode === 'AU') {
      layers.push({
        name: 'Geoscience Australia Foundation Data',
        provider: 'Geoscience Australia',
        description: 'National-scale vector layers: topography, placenames, transport, water, boundaries, and infrastructure.',
        link: 'https://www.ga.gov.au/',
        tags: ['Australia', 'vector', 'topography']
      });
    }

    return layers;
  }

  // ── State-Specific Parcel Data ──────────────────────
  function getStateParcelInfo(state) {
    const statePortals = {
      'Texas': { name: 'Texas Natural Resources Information System (TNRIS)', link: 'https://data.tnris.org/', desc: 'Texas open GIS data portal — includes StratMap parcels, LiDAR, imagery, boundaries, and address points for many counties.' },
      'California': { name: 'California Open Data / CalFire FRAP', link: 'https://gis.data.ca.gov/', desc: 'California state GIS hub — parcels, fire hazard zones, habitat, water resources, and administrative boundaries.' },
      'Florida': { name: 'Florida Geographic Data Library (FGDL)', link: 'https://www.fgdl.org/', desc: 'University of Florida statewide GIS clearinghouse — parcels, land use, soils, environmental layers.' },
      'New York': { name: 'NYS GIS Clearinghouse', link: 'https://gis.ny.gov/', desc: 'New York State GIS data — parcels, tax maps, orthoimagery, and administrative boundaries.' },
      'Colorado': { name: 'CIM / Colorado GeoData', link: 'https://geodata.co.gov/', desc: 'Colorado statewide GIS data portal — parcels, water rights, mining claims, transportation, hazards.' },
      'Washington': { name: 'WA Geospatial Open Data', link: 'https://geo.wa.gov/', desc: 'Washington state open GIS portal — parcels, shorelines, growth boundaries, and environmental data.' },
      'Oregon': { name: 'Oregon Spatial Data Library', link: 'https://spatialdata.oregonexplorer.info/', desc: 'Oregon GIS clearinghouse — tax lot (parcel) boundaries, zoning, land use, streams, and elevation.' },
      'Montana': { name: 'Montana State Library GIS', link: 'https://geoinfo.msl.mt.gov/', desc: 'Montana cadastral and framework data — parcels, ownership, water rights, and public land survey.' },
      'Minnesota': { name: 'MnGeo / Minnesota Geospatial Commons', link: 'https://gisdata.mn.gov/', desc: 'Minnesota open GIS data — statewide parcels, LiDAR, wetlands, and land cover.' },
      'Pennsylvania': { name: 'PASDA', link: 'https://www.pasda.psu.edu/', desc: 'Pennsylvania Spatial Data Access — parcels, zoning, floodplains, geology, and land cover statewide.' },
      'North Carolina': { name: 'NC OneMap', link: 'https://www.nconemap.gov/', desc: 'North Carolina GIS data — statewide parcels, orthoimagery, framework data.' },
      'Virginia': { name: 'Virginia Geographic Information Network (VGIN)', link: 'https://vgin.vdem.virginia.gov/', desc: 'Virginia GIS data clearinghouse — parcels, address points, orthoimagery, and boundaries.' }
    };

    const info = statePortals[state];
    if (!info) return null;

    return {
      name: info.name,
      provider: state + ' State Government',
      description: info.desc,
      link: info.link,
      tags: [state, 'state portal', 'parcels', 'open data']
    };
  }

  // ── US State Abbreviations ──────────────────────────
  function usStateAbbr(name) {
    const map = {
      'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA',
      'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA',
      'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
      'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
      'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS',
      'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH',
      'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
      'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA',
      'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN',
      'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA',
      'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY'
    };
    return map[name] || null;
  }

  // ── Rendering ───────────────────────────────────────
  function renderResults(lat, lon, data) {
    // Header info
    $coords.textContent = `${lat.toFixed(6)}°, ${lon.toFixed(6)}°  ·  UTM ${getUTMZone(lat, lon).name.replace('WGS 84 / ', '')}`;
    $locName.textContent = data.location.display || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    $body.innerHTML = '';

    // Build sections
    const sections = [
      {
        id: 'geographic-crs',
        icon: '🌐',
        iconClass: 'amber',
        title: 'Geographic Coordinate Systems',
        count: data.geographicCRS.length,
        description: 'Geographic CRS define positions on the Earth\'s surface using latitude and longitude, referenced to a specific datum and ellipsoid. These are angular (degree-based) systems.',
        items: data.geographicCRS,
        renderItem: renderCRSItem
      },
      {
        id: 'projected-crs',
        icon: '📐',
        iconClass: 'teal',
        title: 'Projected Coordinate Systems',
        count: data.projectedCRS.length,
        description: 'Projected CRS flatten the Earth onto a 2D plane using a mathematical projection (e.g. Transverse Mercator, Lambert Conformal Conic). Coordinates are in linear units like meters or feet.',
        items: data.projectedCRS,
        renderItem: renderCRSItem
      },
      {
        id: 'datums',
        icon: '🎯',
        iconClass: 'coral',
        title: 'Datums',
        count: data.datums.length,
        description: 'A geodetic datum defines the size, shape, and orientation of the Earth (via an ellipsoid) plus its relationship to the actual surface. Vertical datums define height reference surfaces.',
        items: data.datums,
        renderItem: renderCRSItem
      },
      {
        id: 'ellipsoids',
        icon: '🔵',
        iconClass: 'slate',
        title: 'Ellipsoids',
        count: data.ellipsoids.length,
        description: 'Reference ellipsoids are mathematical surfaces (oblate spheroids) that approximate the shape of the Earth. Each datum is built on an ellipsoid.',
        items: data.ellipsoids,
        renderItem: renderCRSItem
      },
      {
        id: 'geoids',
        icon: '🌊',
        iconClass: 'teal',
        title: 'Geoid Models',
        count: data.geoids.length,
        description: 'A geoid is the equipotential surface of the Earth\'s gravity field that approximates mean sea level. Geoid models convert between ellipsoidal heights (GPS) and orthometric heights (elevation above sea level).',
        items: data.geoids,
        renderItem: renderGeoidItem
      },
      {
        id: 'imagery',
        icon: '🛰️',
        iconClass: 'amber',
        title: 'Imagery & Elevation Data',
        count: data.imagery.length,
        description: 'Satellite and aerial imagery, digital elevation models, and land cover datasets available at this location. Resolutions and revisit rates vary by source.',
        items: data.imagery,
        renderItem: renderSourceItem
      },
      {
        id: 'features',
        icon: '🗺️',
        iconClass: 'coral',
        title: 'Feature Layers & Vector Data',
        count: data.featureLayers.length,
        description: 'Vector datasets providing feature geometries (points, lines, polygons) — boundaries, parcels, hydrology, roads, buildings, and other thematic layers.',
        items: data.featureLayers,
        renderItem: renderSourceItem
      }
    ];

    sections.forEach((sec, i) => {
      if (sec.items.length === 0) return;
      const el = buildSection(sec, i < 3); // auto-expand first 3
      $body.appendChild(el);
    });
  }

  function buildSection(sec, expanded) {
    const div = document.createElement('div');
    div.className = 'result-section' + (expanded ? ' expanded' : '');
    div.id = `section-${sec.id}`;

    const chevronSVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    div.innerHTML = `
      <div class="section-header" role="button" tabindex="0" aria-expanded="${expanded}">
        <div class="section-icon ${sec.iconClass}">${sec.icon}</div>
        <div class="section-label">
          <div class="section-name">${sec.title}</div>
          <div class="section-count">${sec.count} item${sec.count !== 1 ? 's' : ''} found</div>
        </div>
        <div class="section-chevron">${chevronSVG}</div>
      </div>
      <div class="section-body">
        <div class="section-body-inner">
          <p class="section-description">${sec.description}</p>
          <div class="section-items"></div>
        </div>
      </div>
    `;

    // Populate items
    const container = div.querySelector('.section-items');
    sec.items.forEach(item => {
      container.appendChild(sec.renderItem(item));
    });

    // Toggle
    const header = div.querySelector('.section-header');
    header.addEventListener('click', () => {
      div.classList.toggle('expanded');
      header.setAttribute('aria-expanded', div.classList.contains('expanded'));
    });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        header.click();
      }
    });

    return div;
  }

  function renderCRSItem(item) {
    const div = document.createElement('div');
    div.className = 'data-item';
    const codeClass = item.kind?.includes('PROJCRS') ? 'teal' : item.kind?.includes('DATUM') ? 'coral' : item.kind?.includes('ELLIPSOID') ? 'slate' : '';

    div.innerHTML = `
      <div class="data-item-header">
        <span class="data-code ${codeClass}">${esc(item.code)}</span>
        <span class="data-name">${esc(item.name)}</span>
      </div>
      ${item.area ? `<div class="data-desc">Area of use: ${esc(item.area)}</div>` : ''}
      <a href="${esc(item.link)}" target="_blank" rel="noopener" class="data-link">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        View on epsg.io →
      </a>
    `;
    return div;
  }

  function renderGeoidItem(item) {
    const div = document.createElement('div');
    div.className = 'data-item';
    div.innerHTML = `
      <div class="data-item-header">
        <span class="data-code teal">${esc(item.code)}</span>
        <span class="data-name">${esc(item.name)}</span>
      </div>
      <div class="data-desc">${esc(item.description)}</div>
      <div class="data-tags">${item.tags.map(t => `<span class="data-tag">${esc(t)}</span>`).join('')}</div>
      <a href="${esc(item.link)}" target="_blank" rel="noopener" class="data-link">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        More info →
      </a>
    `;
    return div;
  }

  function renderSourceItem(item) {
    const div = document.createElement('div');
    div.className = 'data-item';
    div.innerHTML = `
      <div class="data-item-header">
        <span class="data-code slate">${esc(item.provider)}</span>
        <span class="data-name">${esc(item.name)}</span>
      </div>
      <div class="data-desc">${esc(item.description)}</div>
      <div class="data-tags">${(item.tags || []).map(t => `<span class="data-tag">${esc(t)}</span>`).join('')}</div>
      <a href="${esc(item.link)}" target="_blank" rel="noopener" class="data-link">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Access data →
      </a>
    `;
    return div;
  }

  // ── Utilities ───────────────────────────────────────
  async function fetchJSON(url, extraHeaders) {
    const headers = { 'Accept': 'application/json', ...(extraHeaders || {}) };
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.json();
  }

  function esc(str) {
    if (!str) return '';
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

})();
