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
      featureLayers: [],
      baseStations: [],
      recommendedDatums: null
    };

    // Step 1 — Reverse geocode
    setProgress(20, 'Reverse geocoding…');
    try {
      results.location = await reverseGeocode(lat, lon);
    } catch (e) {
      console.warn('Reverse geocode failed:', e);
      results.location = { display: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, country: '', state: '', county: '', countryCode: '', city: '' };
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

    // Step 2.5 — Recommend datums
    setProgress(50, 'Generating datum recommendations…');
    results.recommendedDatums = recommendDatums(results, lat, lon, results.location);

    // Step 3 — Geoid models
    setProgress(55, 'Identifying geoid models…');
    results.geoids = getGeoidModels(lat, lon, results.location.countryCode);

    // Step 4 — Imagery sources
    setProgress(70, 'Cataloging available imagery…');
    results.imagery = getImagerySources(lat, lon, results.location);

    // Step 5 — Feature layers
    setProgress(85, 'Discovering feature layers…');
    results.featureLayers = getFeatureLayers(lat, lon, results.location);

    // Step 6 — Closest base stations
    setProgress(90, 'Finding nearest base stations…');
    results.baseStations = await getBaseStations(lat, lon, results.location);

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
      terms.push('NAVD88');
      if (loc.state) {
        // State plane coordinate systems
        terms.push(`NAD83 ${loc.state}`);
        terms.push(`SPCS ${loc.state}`);
        terms.push(`${loc.state} ftUS`);
        terms.push(`${loc.state} US survey foot`);
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

  // ── Datum Recommendations ───────────────────────────
  function recommendDatums(data, lat, lon, loc) {
    const rec = {
      horizontal: [],
      vertical: [],
      units: { metric: [], us: [] }
    };

    // Horizontal: Most accurate local projected CRS
    const localProjected = data.projectedCRS.filter(c => !c.area.includes('World') && !c.name.includes('UTM'));
    const utm = data.projectedCRS.find(c => c.name.includes('UTM'));
    rec.horizontal.push(...localProjected.slice(0,1)); // Top local
    if (utm) rec.horizontal.push(utm); // Then UTM
    rec.horizontal.push(data.geographicCRS.find(c => c.code === 'EPSG:4326')); // Global

    // Vertical: Local geoid/vertical datum
    const localVertical = data.datums.filter(d => d.area.includes(loc.country) || d.area.includes(loc.state));
    rec.vertical.push(...localVertical.slice(0,1));
    rec.vertical.push(data.datums.find(d => d.code === 'EPSG:6326')); // WGS84

    // Units: Find metric (m) and US (ftUS) variants
    data.projectedCRS.forEach(c => {
      if (c.name.includes('metre') || !c.name.includes('ft')) {
        rec.units.metric.push(c);
      } else if (c.name.includes('ftUS') || c.name.includes('US survey foot')) {
        rec.units.us.push(c);
      }
    });

    return rec;
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
        description: 'Hybrid geoid model for the conterminous US (CONUS), Alaska, Hawaii, Puerto Rico/Virgin Islands. Converts between NAD 83 ellipsoidal heights and NAVD 88 orthometric heights.',
        link: 'https://geodesy.noaa.gov/GEOID/GEOID18/',
        tags: ['USA', 'NGS', 'hybrid', 'NAVD 88']
      });
      models.push({
        name: 'GEOID12B',
        code: 'GEOID12B',
        description: 'Previous hybrid geoid for US territories. Still used in some applications.',
        link: 'https://geodesy.noaa.gov/GEOID/GEOID12B/',
        tags: ['USA', 'legacy', 'hybrid']
      });
    }

    // Other regions (example)
    if (countryCode === 'AU') {
      models.push({
        name: 'AUSGeoid2020',
        code: 'AUSGeoid2020',
        description: 'Australian geoid model for GDA2020 datum.',
        link: 'https://www.ga.gov.au/scientific-topics/positioning-navigation/geodesy/ausgeoid2020',
        tags: ['Australia', 'GDA2020']
      });
    }

    return models;
  }

  // ── Base Stations ───────────────────────────────────
  async function getBaseStations(lat, lon, loc) {
    const stations = [];

    // GEODNET first (as requested), but since no public API, provide link to tool
    stations.push({
      provider: 'GEODNET',
      name: 'GEODNET PPK Tool',
      description: 'Blockchain-based global GNSS network. Use their PPK tool to find nearest station and download RINEX for post-processing.',
      link: 'https://ppk.geodnet.com/',
      tags: ['global', 'RTK', 'PPK', 'blockchain']
    });

    // NOAA CORS
    try {
      const ecef = latLonToECEF(lat, lon);
      const url = `https://geodesy.noaa.gov/api/nde/ncors?x=${ecef.x}&y=${ecef.y}&z=${ecef.z}`;
      const data = await fetchJSON(url);
      if (Array.isArray(data) && data.length > 0) {
        const closest = data[0];
        stations.push({
          provider: 'NOAA CORS',
          name: closest.name,
          description: `Closest CORS station: ${closest.corsId}, distance ${Math.round(closest.distance / 1000)} km. Download RINEX data for post-processing.`,
          link: `https://geodesy.noaa.gov/corsdata/rinex/${closest.corsId.toLowerCase()}`,
          tags: ['USA', 'NOAA', 'CORS', 'RINEX']
        });
      }
    } catch (e) {
      console.warn('CORS fetch failed:', e);
    }

    return stations;
  }

  function latLonToECEF(lat, lon, h = 0) {
    const degToRad = Math.PI / 180;
    const latRad = lat * degToRad;
    const lonRad = lon * degToRad;
    const a = 6378137.0; // WGS84 semi-major axis
    const b = 6356752.3142; // semi-minor
    const e2 = 1 - (b * b) / (a * a);
    const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);

    const x = (N + h) * Math.cos(latRad) * Math.cos(lonRad);
    const y = (N + h) * Math.cos(latRad) * Math.sin(lonRad);
    const z = (N * (1 - e2) + h) * Math.sin(latRad);

    return { x, y, z };
  }

  // ── Imagery Sources ─────────────────────────────────
  function getImagerySources(lat, lon, loc) {
    const sources = [];

    // Global
    sources.push({
      name: 'Sentinel-2 (ESA)',
      provider: 'European Space Agency',
      description: 'Multispectral imagery at 10-60m resolution, 5-day revisit. Cloud-free composites available.',
      link: 'https://scihub.copernicus.eu/',
      tags: ['satellite', 'multispectral', 'global']
    });
    sources.push({
      name: 'Landsat 8/9 (USGS/NASA)',
      provider: 'USGS',
      description: 'Multispectral at 15-100m, 16-day revisit. Analysis-ready data (ARD) available.',
      link: 'https://earthexplorer.usgs.gov/',
      tags: ['satellite', 'multispectral', 'global']
    });
    sources.push({
      name: 'SRTM (NASA)',
      provider: 'NASA',
      description: 'Global digital elevation model at 30m resolution (1 arc-second).',
      link: 'https://earthexplorer.usgs.gov/',
      tags: ['elevation', 'DEM', 'global']
    });

    // US-specific
    if (loc.countryCode === 'US') {
      sources.push({
        name: 'NAIP (USDA)',
        provider: 'USDA',
        description: 'High-resolution aerial imagery (0.6-1m) for agriculture, 3-year cycle.',
        link: 'https://naip-usdaonline.hub.arcgis.com/',
        tags: ['aerial', 'high-res', 'USA']
      });
      sources.push({
        name: '3DEP (USGS)',
        provider: 'USGS',
        description: 'National 3D Elevation Program — LiDAR-derived DEMs at 1m-30m resolution.',
        link: 'https://www.usgs.gov/3d-elevation-program',
        tags: ['elevation', 'LiDAR', 'USA']
      });
    }

    return sources;
  }

  // ── Feature Layers ──────────────────────────────────
  function getFeatureLayers(lat, lon, loc) {
    const layers = [];

    // Global
    layers.push({
      name: 'OpenStreetMap',
      provider: 'OSM Community',
      description: 'Crowdsourced vector data — roads, buildings, POIs, land use.',
      link: 'https://www.openstreetmap.org/export',
      tags: ['vector', 'global', 'crowdsourced']
    });
    layers.push({
      name: 'Natural Earth',
      provider: 'Natural Earth',
      description: 'Public domain vector and raster map data at various scales.',
      link: 'https://www.naturalearthdata.com/',
      tags: ['vector', 'global', 'boundaries']
    });

    // US-specific
    if (loc.countryCode === 'US') {
      layers.push({
        name: 'TIGER (Census)',
        provider: 'US Census Bureau',
        description: 'Topologically Integrated Geographic Encoding and Referencing — boundaries, roads, addresses.',
        link: 'https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html',
        tags: ['vector', 'USA', 'boundaries']
      });
      layers.push({
        name: 'National Hydrography Dataset (NHD)',
        provider: 'USGS',
        description: 'Surface water features — rivers, lakes, streams, watersheds.',
        link: 'https://www.usgs.gov/national-hydrography/national-hydrography-dataset',
        tags: ['vector', 'hydrography', 'USA']
      });
      layers.push({
        name: 'National Flood Hazard Layer (NFHL)',
        provider: 'FEMA',
        description: 'Flood zones, risk areas, base flood elevations.',
        link: 'https://www.fema.gov/flood-maps/national-flood-hazard-layer',
        tags: ['vector', 'hazards', 'USA']
      });

      // State-specific parcel data if available
      const statePortal = getStateGISPortal(loc.state);
      if (statePortal) {
        layers.push(statePortal);
      }
    }

    return layers;
  }

  function getStateGISPortal(state) {
    if (!state) return null;

    const statePortals = {
      'Texas': { name: 'Texas Natural Resources Information System (TNRIS)', provider: 'Texas State Government', description: 'Texas statewide GIS data — imagery, elevation, hydrography, boundaries, parcels in select counties.', link: 'https://data.tnris.org/', tags: ['Texas', 'state portal', 'parcels', 'open data'] },
      'California': { name: 'California Geoportal', provider: 'California State Government', description: 'California open GIS data — statewide parcels, land use, environmental, transportation.', link: 'https://gis.data.ca.gov/', tags: ['California', 'state portal', 'parcels', 'open data'] },
      // Add more as needed
    };

    return statePortals[state] || null;
  }

  // ── US State Abbreviations ──────────────────────────
  function usStateAbbr(name) {
    const map = {
      // ... (same as before)
    };
    return map[name] || null;
  }

  // ── Rendering ───────────────────────────────────────
  function renderResults(lat, lon, data) {
    // Header info
    $coords.textContent = `${lat.toFixed(6)}°, ${lon.toFixed(6)}°  ·  UTM ${getUTMZone(lat, lon).name.replace('WGS 84 / ', '')}`;
    $locName.textContent = data.location.display || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    $body.innerHTML = '';

    // New: Recommendation section
    const recSec = {
      id: 'recommendations',
      icon: '⭐',
      iconClass: 'amber',
      title: 'Recommended Datums for Surveying',
      count: 1,
      description: 'Most accurate combinations of horizontal and vertical datums for mapping/survey work at this location. Local options first, with metric (m) and US survey foot (ftUS) units where available.',
      items: [data.recommendedDatums],
      renderItem: renderRecommendationItem
    };
    $body.appendChild(buildSection(recSec, true));

    // New: Base stations section
    const baseSec = {
      id: 'base-stations',
      icon: '📡',
      iconClass: 'teal',
      title: 'Nearest Base Stations for RINEX',
      count: data.baseStations.length,
      description: 'Closest GNSS base stations for downloading RINEX files for post-processing. GEODNET mentioned first.',
      items: data.baseStations,
      renderItem: renderSourceItem
    };
    $body.appendChild(buildSection(baseSec, true));

    // Existing sections
    const sections = [
      // ... (same as before: geographic-crs, projected-crs, datums, ellipsoids, geoids, imagery, features)
    ];

    sections.forEach((sec, i) => {
      if (sec.items.length === 0) return;
      const el = buildSection(sec, i < 3); // auto-expand first 3
      $body.appendChild(el);
    });
  }

  function renderRecommendationItem(rec) {
    const div = document.createElement('div');
    div.className = 'data-item';
    let html = '<div class="data-desc">';

    // Horizontal
    html += '<strong>Horizontal Datums:</strong><br>';
    rec.horizontal.forEach(h => {
      html += `${h.name} (${h.code}) - ${h.area}<br><a href="${h.link}" class="data-link">View details →</a><br>';
    });

    // Vertical
    html += '<br><strong>Vertical Datums:</strong><br>';
    rec.vertical.forEach(v => {
      html += `${v.name} (${v.code}) - ${v.area}<br><a href="${v.link}" class="data-link">View details →</a><br>';
    });

    // Units
    html += '<br><strong>Unit Options:</strong><br>';
    html += 'Metric (meters):<br>';
    rec.units.metric.slice(0,3).forEach(m => {
      html += `${m.name} (${m.code})<br>`;
    });
    html += 'US (survey feet):<br>';
    rec.units.us.slice(0,3).forEach(u => {
      html += `${u.name} (${u.code})<br>`;
    });

    html += '</div>';
    div.innerHTML = html;
    return div;
  }

  // ── Utilities ─────────────────────────────────────── (same as before)

})();