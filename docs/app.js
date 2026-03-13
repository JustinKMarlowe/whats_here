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
      results.location = { display: lat.toFixed(5) + ', ' + lon.toFixed(5), country: '', state: '', county: '', countryCode: '', city: '' };
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

    // Step 2.5 — (moved to after geoids)

    // Step 3 — Geoid models
    setProgress(55, 'Identifying geoid models…');
    results.geoids = getGeoidModels(lat, lon, results.location.countryCode);

    // Step 3.5 — Recommend datums (needs CRS + geoids + ellipsoids)
    setProgress(58, 'Generating recommendations…');
    results.recommendedDatums = recommendDatums(results, lat, lon, results.location);

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
    const url = 'https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lon + '&format=json&zoom=10&addressdetails=1';
    const resp = await fetchJSON(url, { 'Accept-Language': 'en' });
    const addr = resp.address || {};
    return {
      display: resp.display_name || lat.toFixed(5) + ', ' + lon.toFixed(5),
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
        const url = 'https://epsg.io/?q=' + encodeURIComponent(term) + '&format=json&trans=0';
        const data = await fetchJSON(url);
        if (data && data.results) {
          allResults.push(...data.results);
        }
      } catch (e) {
        console.warn('EPSG search failed for "' + term + '":', e);
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
        code: 'EPSG:' + r.code,
        name: r.name,
        area: r.area || '',
        accuracy: r.accuracy,
        kind: r.kind,
        deprecated: r.deprecated || false,
        link: 'https://epsg.io/' + r.code
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

    // For US/NAD83 work, GRS 1980 is the reference ellipsoid
    if (loc.countryCode === 'US') {
      ensureEntry(ellipsoids, 'EPSG:7019', 'GRS 1980', 'ELLIPSOID', 'World');
    }

    // Add UTM zone
    const utmZone = getUTMZone(lat, lon);
    if (utmZone) {
      ensureEntry(projected, utmZone.code, utmZone.name, 'CRS-PROJCRS', utmZone.area);
    }

    // Ensure State Plane zone entries are present (critical — EPSG.io search may not return them)
    if (loc.countryCode === 'US' && loc.state) {
      var spZone = getStatePlaneZone(lat, lon, loc.state);
      if (spZone && spZone.ensure) {
        spZone.ensure.forEach(function(e) {
          ensureEntry(projected, e.code, e.name, e.kind, e.area);
        });
      }
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

    return { geographic: geographic, projected: projected, datums: datums, ellipsoids: ellipsoids };
  }

  function buildSearchTerms(lat, lon, loc) {
    var terms = [];

    // Country-level
    if (loc.countryCode === 'US') {
      terms.push('NAD83');
      terms.push('NAD27');
      terms.push('NAVD88');

      // State Plane zone-specific searches (critical for finding codes like EPSG:6588)
      var spZone = getStatePlaneZone(lat, lon, loc.state);
      if (spZone) {
        terms.push.apply(terms, spZone.searchTerms);
      }

      if (loc.state) {
        terms.push('NAD83 ' + loc.state);
        terms.push('SPCS ' + loc.state);
        terms.push(loc.state + ' ftUS');
        terms.push(loc.state + ' US survey foot');
        var stateAbbr = usStateAbbr(loc.state);
        if (stateAbbr) {
          terms.push('NAD83 / ' + loc.state);
        }
      }
    } else if (loc.countryCode) {
      terms.push(loc.country);
      if (loc.state) terms.push(loc.state);
    }

    // UTM zone search
    var utmNum = Math.floor((lon + 180) / 6) + 1;
    var hemi = lat >= 0 ? 'N' : 'S';
    terms.push('UTM zone ' + utmNum + hemi);

    // WGS 84 / global
    terms.push('WGS 84');

    return terms;
  }

  function ensureEntry(arr, code, name, kind, area) {
    if (!arr.find(e => e.code === code)) {
      arr.unshift({
        code: code, name: name, area: area || '', kind: kind,
        deprecated: false,
        link: 'https://epsg.io/' + code.replace('EPSG:', '')
      });
    }
  }

  function getUTMZone(lat, lon) {
    const zone = Math.floor((lon + 180) / 6) + 1;
    const hemi = lat >= 0 ? 'N' : 'S';
    const epsgBase = lat >= 0 ? 32600 : 32700;
    const code = 'EPSG:' + (epsgBase + zone);
    return {
      code: code,
      name: 'WGS 84 / UTM zone ' + zone + hemi,
      area: 'UTM Zone ' + zone + hemi
    };
  }

  // ── State Plane Zone Lookup ──────────────────────────
  // Returns the SPCS zone name and key EPSG codes for the user's lat/lon.
  // This ensures that zone-specific codes (like EPSG:6588) always appear.
  function getStatePlaneZone(lat, lon, state) {
    if (!state) return null;

    // Texas zones — approximate latitude boundaries
    if (state === 'Texas') {
      var zone;
      if (lat >= 34.0)                          zone = 'North';
      else if (lat >= 31.7)                     zone = 'North Central';
      else if (lat >= 30.1)                     zone = 'Central';
      else if (lat >= 28.0)                     zone = 'South Central';
      else                                      zone = 'South';

      var texasZones = {
        'North':         { nad83ft: 2276, nad83_2011: 6581, nad83_2011ft: 6582 },
        'North Central': { nad83ft: 2277, nad83_2011: 6583, nad83_2011ft: 6584 },
        'Central':       { nad83ft: 2278, nad83_2011: 6585, nad83_2011ft: 6586 },
        'South Central': { nad83ft: 2279, nad83_2011: 6587, nad83_2011ft: 6588 },
        'South':         { nad83ft: 2280, nad83_2011: 6589, nad83_2011ft: 6590 }
      };

      // Correct: San Antonio (29.4°N) → South Central
      // But the zone boundaries above might mis-classify — let's use the actual SPCS boundaries more carefully
      // SPCS83 Texas zones (latitude of origin / approximate coverage):
      //   North:         34°39'N–36°30'N
      //   North Central: 31°40'N–34°39'N (origin 31°40')
      //   Central:       29°40'N–31°50'N (origin 29°40')
      //   South Central: 27°50'N–30°10'N (origin 27°50')
      //   South:         25°40'N–28°25'N (origin 25°40')
      // Overlap exists — we use midpoints of the overlapping ranges
      if (lat >= 34.65)       zone = 'North';
      else if (lat >= 31.75)  zone = 'North Central';
      else if (lat >= 30.0)   zone = 'Central';
      else if (lat >= 28.1)   zone = 'South Central';
      else                    zone = 'South';

      var codes = texasZones[zone];
      return {
        zoneName: 'Texas ' + zone,
        searchTerms: [
          'NAD83(2011) Texas ' + zone,
          'NAD83 Texas ' + zone,
          'Texas ' + zone + ' ftUS'
        ],
        ensure: [
          { code: 'EPSG:' + codes.nad83_2011ft, name: 'NAD83(2011) / Texas ' + zone + ' (ftUS)', kind: 'CRS-PROJCRS', area: 'United States (USA) - Texas - ' + zone },
          { code: 'EPSG:' + codes.nad83_2011,   name: 'NAD83(2011) / Texas ' + zone,             kind: 'CRS-PROJCRS', area: 'United States (USA) - Texas - ' + zone },
          { code: 'EPSG:' + codes.nad83ft,       name: 'NAD83 / Texas ' + zone + ' (ftUS)',       kind: 'CRS-PROJCRS', area: 'United States (USA) - Texas - ' + zone }
        ]
      };
    }

    // California zones — approximate latitude boundaries (6 zones)
    if (state === 'California') {
      var caZone;
      if (lat >= 40.0) caZone = 'zone 1';
      else if (lat >= 38.3) caZone = 'zone 2';
      else if (lat >= 37.0) caZone = 'zone 3';
      else if (lat >= 35.8) caZone = 'zone 4';
      else if (lat >= 34.0) caZone = 'zone 5';
      else caZone = 'zone 6';
      return {
        zoneName: 'California ' + caZone,
        searchTerms: [
          'NAD83(2011) California ' + caZone,
          'NAD83 California ' + caZone
        ],
        ensure: []
      };
    }

    // Florida — 3 zones
    if (state === 'Florida') {
      var flZone;
      if (lat >= 29.6) flZone = 'North';
      else if (lat >= 27.0) flZone = 'East';
      else flZone = 'West';
      return {
        zoneName: 'Florida ' + flZone,
        searchTerms: [
          'NAD83(2011) Florida ' + flZone,
          'NAD83 Florida ' + flZone
        ],
        ensure: []
      };
    }

    // Generic fallback — just add the state name with NAD83(2011)
    return {
      zoneName: state,
      searchTerms: [
        'NAD83(2011) ' + state
      ],
      ensure: []
    };
  }

  // ── Datum Recommendations ───────────────────────────
  function recommendDatums(data, lat, lon, loc) {
    var rec = {
      horizontal: [],
      vertical: [],
      geoid: [],
      ellipsoid: [],
      units: { metric: [], us: [] },
      statePlaneZone: null
    };

    // Determine State Plane zone
    if (loc.countryCode === 'US' && loc.state) {
      rec.statePlaneZone = getStatePlaneZone(lat, lon, loc.state);
    }

    // Horizontal: Prioritize NAD83(2011) State Plane, then NAD83 State Plane, then UTM, then WGS 84
    var nad83_2011_local = data.projectedCRS.filter(function(c) {
      return c.name.indexOf('NAD83(2011)') !== -1 && c.name.indexOf('UTM') === -1;
    });
    var nad83_local = data.projectedCRS.filter(function(c) {
      return c.name.indexOf('NAD83') !== -1 && c.name.indexOf('NAD83(2011)') === -1 && c.name.indexOf('UTM') === -1 && c.area !== 'World';
    });
    var utm = data.projectedCRS.find(function(c) { return c.name.indexOf('UTM') !== -1; });

    // Prefer ftUS versions for US survey work
    var nad83_2011_ft = nad83_2011_local.filter(function(c) { return c.name.indexOf('ftUS') !== -1; });
    var nad83_2011_m  = nad83_2011_local.filter(function(c) { return c.name.indexOf('ftUS') === -1; });

    if (nad83_2011_ft.length > 0) rec.horizontal.push(nad83_2011_ft[0]);
    if (nad83_2011_m.length > 0) rec.horizontal.push(nad83_2011_m[0]);
    if (nad83_local.length > 0 && rec.horizontal.length < 3) rec.horizontal.push(nad83_local[0]);
    if (utm) rec.horizontal.push(utm);
    var wgs84 = data.geographicCRS.find(function(c) { return c.code === 'EPSG:4326'; });
    if (wgs84) rec.horizontal.push(wgs84);

    // Vertical: Local vertical datums
    var localVertical = data.datums.filter(function(d) {
      return d.kind === 'DATUM-VERTICAL' || d.name.indexOf('NAVD') !== -1;
    });
    if (localVertical.length > 0) {
      rec.vertical.push.apply(rec.vertical, localVertical.slice(0, 2));
    }
    // Also add any local geodetic datums
    var localGeodetic = data.datums.filter(function(d) {
      return (d.kind === 'DATUM' || d.kind === 'DATUM-GEODETIC') && d.area !== 'World';
    });
    if (localGeodetic.length > 0) {
      rec.vertical.push.apply(rec.vertical, localGeodetic.slice(0, 1));
    }
    var wgs84Datum = data.datums.find(function(d) { return d.code === 'EPSG:6326'; });
    if (wgs84Datum) rec.vertical.push(wgs84Datum);

    // Geoid: Recommend the best geoid for this location
    if (data.geoids && data.geoids.length > 0) {
      // For US, prioritize GEOID18 → GEOID12B → EGM2008
      if (loc.countryCode === 'US') {
        var geoid18 = data.geoids.find(function(g) { return g.code === 'GEOID18'; });
        var egm2008 = data.geoids.find(function(g) { return g.code === 'EGM2008'; });
        if (geoid18) rec.geoid.push(geoid18);
        if (egm2008) rec.geoid.push(egm2008);
      } else {
        // Non-US: regional first, then global
        var regional = data.geoids.filter(function(g) { return g.tags.indexOf('global') === -1; });
        var global   = data.geoids.filter(function(g) { return g.tags.indexOf('global') !== -1; });
        rec.geoid.push.apply(rec.geoid, regional.slice(0, 1));
        if (global.length > 0) rec.geoid.push(global[0]);
      }
    }

    // Ellipsoid: Recommend GRS 1980 for NAD83 work, WGS 84 for GPS
    if (data.ellipsoids && data.ellipsoids.length > 0) {
      var grs1980 = data.ellipsoids.find(function(e) { return e.name.indexOf('GRS 1980') !== -1 || e.code === 'EPSG:7019'; });
      var wgs84Ell = data.ellipsoids.find(function(e) { return e.code === 'EPSG:7030'; });
      if (grs1980) rec.ellipsoid.push(grs1980);
      if (wgs84Ell) rec.ellipsoid.push(wgs84Ell);
    }

    // Units: Find metric (m) and US (ftUS) variants
    data.projectedCRS.forEach(function(c) {
      if (c.name.indexOf('ftUS') !== -1 || c.name.indexOf('US survey foot') !== -1) {
        rec.units.us.push(c);
      } else {
        rec.units.metric.push(c);
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
    var stations = [];

    // ── GEODNET stations ──
    // GEODNET exposes a public JSON feed of all active miners/stations.
    // We fetch the full list, compute distances, and pick the closest ones.
    try {
      var geoResp = await fetch('https://api.geodnet.com/api/v1/miners/map');
      if (geoResp.ok) {
        var geoData = await geoResp.json();
        var miners = [];
        if (Array.isArray(geoData)) {
          miners = geoData;
        } else if (geoData && Array.isArray(geoData.data)) {
          miners = geoData.data;
        } else if (geoData && Array.isArray(geoData.miners)) {
          miners = geoData.miners;
        }
        // Each miner may have lat/lng or latitude/longitude
        var geoStations = [];
        for (var gi = 0; gi < miners.length; gi++) {
          var m = miners[gi];
          var mLat = m.lat || m.latitude || (m.location && m.location.lat) || null;
          var mLon = m.lng || m.lon || m.longitude || (m.location && (m.location.lng || m.location.lon)) || null;
          if (mLat !== null && mLon !== null && !isNaN(mLat) && !isNaN(mLon)) {
            var d = haversineDistance(lat, lon, mLat, mLon);
            geoStations.push({
              provider: 'GEODNET',
              name: m.name || m.minerId || m.id || 'GEODNET Station',
              stationId: m.minerId || m.id || m.name || '',
              lat: parseFloat(mLat),
              lon: parseFloat(mLon),
              distanceM: d,
              description: '',
              link: 'https://ppk.geodnet.com/',
              tags: ['GEODNET', 'RTK', 'PPK', 'RINEX'],
              color: '#22c55e' // green
            });
          }
        }
        // Sort by distance, take closest 3
        geoStations.sort(function(a, b) { return a.distanceM - b.distanceM; });
        var geoClosest = geoStations.slice(0, 3);
        for (var gc = 0; gc < geoClosest.length; gc++) {
          var gs = geoClosest[gc];
          var dKm = (gs.distanceM / 1000).toFixed(1);
          var dMi = (gs.distanceM / 1609.344).toFixed(1);
          gs.description = 'GEODNET station ' + gs.stationId + ' — ' + dKm + ' km / ' + dMi + ' mi away. Download RINEX via GEODNET PPK tool.';
          stations.push(gs);
        }
      }
    } catch (e) {
      console.warn('GEODNET fetch failed:', e);
    }

    // If no GEODNET stations were found via API, add a fallback link
    if (!stations.find(function(s) { return s.provider === 'GEODNET'; })) {
      stations.push({
        provider: 'GEODNET',
        name: 'GEODNET PPK Tool',
        stationId: '',
        lat: null,
        lon: null,
        distanceM: null,
        description: 'Blockchain-based global GNSS network. Use their PPK tool to find nearest station and download RINEX for post-processing.',
        link: 'https://ppk.geodnet.com/',
        tags: ['global', 'RTK', 'PPK', 'RINEX'],
        color: '#22c55e'
      });
    }

    // ── NOAA CORS stations ──
    try {
      var ecef = latLonToECEF(lat, lon);
      var corsUrl = 'https://geodesy.noaa.gov/api/nde/ncors?x=' + ecef.x.toFixed(2) + '&y=' + ecef.y.toFixed(2) + '&z=' + ecef.z.toFixed(2);
      var corsData = await fetchJSON(corsUrl);
      if (Array.isArray(corsData) && corsData.length > 0) {
        // Take up to 5 closest
        var corsSlice = corsData.slice(0, 5);
        for (var ci = 0; ci < corsSlice.length; ci++) {
          var cs = corsSlice[ci];
          // The API returns ECEF coords; try lat/lon fields first, else convert
          var cLat = cs.latitude || cs.lat || null;
          var cLon = cs.longitude || cs.lon || null;

          if (cLat === null || cLon === null) {
            // Convert ECEF back to lat/lon if available
            if (cs.x && cs.y && cs.z) {
              var ll = ecefToLatLon(cs.x, cs.y, cs.z);
              cLat = ll.lat;
              cLon = ll.lon;
            }
          }

          var distM = cs.distance || null; // in meters from API
          if (distM === null && cLat !== null && cLon !== null) {
            distM = haversineDistance(lat, lon, cLat, cLon);
          }

          var dKmC = distM ? (distM / 1000).toFixed(1) : '?';
          var dMiC = distM ? (distM / 1609.344).toFixed(1) : '?';

          stations.push({
            provider: 'NOAA CORS',
            name: cs.name || cs.corsId || 'CORS Station',
            stationId: cs.corsId || '',
            lat: cLat ? parseFloat(cLat) : null,
            lon: cLon ? parseFloat(cLon) : null,
            distanceM: distM,
            description: 'CORS station ' + (cs.corsId || '') + ' — ' + dKmC + ' km / ' + dMiC + ' mi away. RINEX data available for post-processing.',
            link: 'https://geodesy.noaa.gov/corsdata/rinex/' + (cs.corsId || '').toLowerCase(),
            tags: ['NOAA', 'CORS', 'RINEX', 'USA'],
            color: '#3b82f6' // blue
          });
        }
      }
    } catch (e) {
      console.warn('NOAA CORS fetch failed:', e);
    }

    // Sort all stations by distance (null distances last)
    stations.sort(function(a, b) {
      if (a.distanceM === null) return 1;
      if (b.distanceM === null) return -1;
      return a.distanceM - b.distanceM;
    });

    return stations;
  }

  // ── Haversine Distance (meters) ─────────────────────
  function haversineDistance(lat1, lon1, lat2, lon2) {
    var R = 6371000; // Earth radius in meters
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ── ECEF → Lat/Lon conversion ───────────────────────
  function ecefToLatLon(x, y, z) {
    var a = 6378137.0;
    var b = 6356752.3142;
    var e2 = 1 - (b * b) / (a * a);
    var ep2 = (a * a - b * b) / (b * b);
    var p = Math.sqrt(x * x + y * y);
    var theta = Math.atan2(z * a, p * b);
    var lonRad = Math.atan2(y, x);
    var latRad = Math.atan2(
      z + ep2 * b * Math.pow(Math.sin(theta), 3),
      p - e2 * a * Math.pow(Math.cos(theta), 3)
    );
    return {
      lat: latRad * 180 / Math.PI,
      lon: lonRad * 180 / Math.PI
    };
  }

  function latLonToECEF(lat, lon, h) {
    if (h === undefined) h = 0;
    const degToRad = Math.PI / 180;
    const latRad = lat * degToRad;
    const lonRad = lon * degToRad;
    const a = 6378137.0; // WGS84 semi-major axis
    const b = 6356752.3142; // semi-minor
    const e2 = 1 - (b * b) / (a * a);
    const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) * Math.sin(latRad));

    const x = (N + h) * Math.cos(latRad) * Math.cos(lonRad);
    const y = (N + h) * Math.cos(latRad) * Math.sin(lonRad);
    const z = (N * (1 - e2) + h) * Math.sin(latRad);

    return { x: x, y: y, z: z };
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
    $coords.textContent = lat.toFixed(6) + '°, ' + lon.toFixed(6) + '°  ·  UTM ' + getUTMZone(lat, lon).name.replace('WGS 84 / ', '');
    $locName.textContent = data.location.display || lat.toFixed(5) + ', ' + lon.toFixed(5);

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

    // Location & Base Station map
    var stationsWithCoords = data.baseStations.filter(function(s) {
      return s.lat !== null && s.lon !== null;
    });
    var mapStationCount = stationsWithCoords.length;
    var mapDiv = document.createElement('div');
    mapDiv.className = 'result-section expanded';
    mapDiv.id = 'section-location-map';
    mapDiv.innerHTML =
      '<div class="section-header" role="button" tabindex="0" aria-expanded="true">' +
        '<div class="section-icon amber">📍</div>' +
        '<div class="section-label">' +
          '<div class="section-name">Your Location & Nearby Base Stations</div>' +
          '<div class="section-count">' + lat.toFixed(5) + ', ' + lon.toFixed(5) + (mapStationCount > 0 ? '  ·  ' + mapStationCount + ' station' + (mapStationCount !== 1 ? 's' : '') : '') + '</div>' +
        '</div>' +
        '<div class="section-chevron"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></div>' +
      '</div>' +
      '<div class="section-body">' +
        '<div class="section-body-inner">' +
          '<div id="location-map" style="width:100%;height:340px;border-radius:8px;overflow:hidden;"></div>' +
          '<div id="map-legend" class="map-legend"></div>' +
        '</div>' +
      '</div>';
    $body.appendChild(mapDiv);

    // Wire toggle for the map section
    var mapHeader = mapDiv.querySelector('.section-header');
    mapHeader.addEventListener('click', function() {
      mapDiv.classList.toggle('expanded');
      mapHeader.setAttribute('aria-expanded', mapDiv.classList.contains('expanded'));
      if (mapDiv.classList.contains('expanded') && window._whLocationMap) {
        setTimeout(function() { window._whLocationMap.invalidateSize(); }, 350);
      }
    });
    mapHeader.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mapHeader.click(); }
    });

    // Build legend
    var legendEl = document.getElementById('map-legend');
    var legendHtml = '<div class="legend-item"><span class="legend-swatch" style="background:var(--amber)"></span> You</div>';
    var providerColors = {};
    stationsWithCoords.forEach(function(s) {
      if (!providerColors[s.provider]) {
        providerColors[s.provider] = s.color || '#3b82f6';
      }
    });
    Object.keys(providerColors).forEach(function(prov) {
      legendHtml += '<div class="legend-item"><span class="legend-swatch" style="background:' + providerColors[prov] + '"></span> ' + esc(prov) + '</div>';
    });
    legendEl.innerHTML = legendHtml;

    // Initialize Leaflet map after DOM insert
    var capturedStations = stationsWithCoords;
    setTimeout(function() {
      try {
        if (window._whLocationMap) {
          window._whLocationMap.remove();
        }
        var map = L.map('location-map', {
          zoomControl: true,
          attributionControl: true,
          scrollWheelZoom: false
        }).setView([lat, lon], 10);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 18
        }).addTo(map);

        // ── Person icon for user location ──
        var personSvg =
          '<svg viewBox="0 0 24 32" width="28" height="36" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="12" cy="6" r="5.5" fill="#d4a24e" stroke="#fff" stroke-width="1.5"/>' +
            '<path d="M12 13c-5.5 0-10 3.5-10 7v2.5c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V20c0-3.5-4.5-7-10-7z" fill="#d4a24e" stroke="#fff" stroke-width="1.5"/>' +
            '<circle cx="12" cy="28" r="3" fill="#d4a24e" opacity="0.3"/>' +
          '</svg>';
        var personIcon = L.divIcon({
          className: 'map-person-icon',
          html: '<div class="person-icon-wrap">' + personSvg + '<div class="person-pulse-ring"></div></div>',
          iconSize: [28, 36],
          iconAnchor: [14, 36],
          popupAnchor: [0, -36]
        });
        L.marker([lat, lon], { icon: personIcon, zIndexOffset: 1000 })
          .bindPopup('<strong>You are here</strong><br>' + lat.toFixed(6) + '°, ' + lon.toFixed(6) + '°')
          .addTo(map);

        // ── Base station markers + distance lines ──
        var bounds = L.latLngBounds([[lat, lon]]);

        capturedStations.forEach(function(station) {
          var sColor = station.color || '#3b82f6';

          // Antenna/tower icon
          var antennaSvg =
            '<svg viewBox="0 0 24 32" width="22" height="30" xmlns="http://www.w3.org/2000/svg">' +
              '<line x1="12" y1="8" x2="12" y2="28" stroke="' + sColor + '" stroke-width="2.5" stroke-linecap="round"/>' +
              '<line x1="6" y1="20" x2="12" y2="12" stroke="' + sColor + '" stroke-width="1.8" stroke-linecap="round"/>' +
              '<line x1="18" y1="20" x2="12" y2="12" stroke="' + sColor + '" stroke-width="1.8" stroke-linecap="round"/>' +
              '<circle cx="12" cy="6" r="3.5" fill="' + sColor + '" stroke="#fff" stroke-width="1.2"/>' +
              '<line x1="5" y1="3" x2="9" y2="6" stroke="' + sColor + '" stroke-width="1.2" stroke-linecap="round" opacity="0.6"/>' +
              '<line x1="19" y1="3" x2="15" y2="6" stroke="' + sColor + '" stroke-width="1.2" stroke-linecap="round" opacity="0.6"/>' +
              '<line x1="3" y1="7" x2="8" y2="7" stroke="' + sColor + '" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>' +
              '<line x1="21" y1="7" x2="16" y2="7" stroke="' + sColor + '" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>' +
            '</svg>';
          var stationIcon = L.divIcon({
            className: 'map-station-icon',
            html: antennaSvg,
            iconSize: [22, 30],
            iconAnchor: [11, 30],
            popupAnchor: [0, -30]
          });

          var stationMarker = L.marker([station.lat, station.lon], { icon: stationIcon })
            .bindPopup(
              '<strong>' + esc(station.name) + '</strong><br>' +
              '<span style="color:' + sColor + '">' + esc(station.provider) + '</span><br>' +
              station.lat.toFixed(5) + '°, ' + station.lon.toFixed(5) + '°' +
              (station.stationId ? '<br>ID: ' + esc(station.stationId) : '')
            )
            .addTo(map);

          bounds.extend([station.lat, station.lon]);

          // Distance line (dashed)
          var line = L.polyline(
            [[lat, lon], [station.lat, station.lon]],
            {
              color: sColor,
              weight: 2,
              opacity: 0.6,
              dashArray: '6 4'
            }
          ).addTo(map);

          // Distance label at midpoint
          var midLat = (lat + station.lat) / 2;
          var midLon = (lon + station.lon) / 2;
          var dKm = (station.distanceM / 1000).toFixed(1);
          var dMi = (station.distanceM / 1609.344).toFixed(1);

          var labelIcon = L.divIcon({
            className: 'map-distance-label',
            html: '<div class="distance-label-inner" style="border-color:' + sColor + '">' +
                    '<span class="dist-val">' + dMi + ' mi</span>' +
                    '<span class="dist-sep">|</span>' +
                    '<span class="dist-val">' + dKm + ' km</span>' +
                  '</div>',
            iconSize: [0, 0],
            iconAnchor: [0, 0]
          });
          L.marker([midLat, midLon], { icon: labelIcon, interactive: false }).addTo(map);
        });

        // Fit map to show all markers with padding
        if (capturedStations.length > 0) {
          map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
        }

        window._whLocationMap = map;
      } catch (e) {
        console.warn('Map init failed:', e);
      }
    }, 100);

    // New: Base stations section
    const baseSec = {
      id: 'base-stations',
      icon: '📡',
      iconClass: 'teal',
      title: 'Nearest Base Stations for RINEX',
      count: data.baseStations.length,
      description: 'Closest GNSS base stations for downloading RINEX files for post-processing. Includes GEODNET and NOAA CORS networks. Distances shown in both km and miles.',
      items: data.baseStations,
      renderItem: renderBaseStationItem
    };
    $body.appendChild(buildSection(baseSec, true));

    // Existing sections
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
    div.id = 'section-' + sec.id;

    const chevronSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

    div.innerHTML = 
      '<div class="section-header" role="button" tabindex="0" aria-expanded="' + expanded + '">' +
        '<div class="section-icon ' + sec.iconClass + '">' + sec.icon + '</div>' +
        '<div class="section-label">' +
          '<div class="section-name">' + sec.title + '</div>' +
          '<div class="section-count">' + sec.count + ' item' + (sec.count !== 1 ? 's' : '') + ' found</div>' +
        '</div>' +
        '<div class="section-chevron">' + chevronSVG + '</div>' +
      '</div>' +
      '<div class="section-body">' +
        '<div class="section-body-inner">' +
          '<p class="section-description">' + sec.description + '</p>' +
          '<div class="section-items"></div>' +
        '</div>' +
      '</div>';

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

  function renderRecommendationItem(rec) {
    var div = document.createElement('div');
    div.className = 'data-item';
    var html = '';

    // Zone callout
    if (rec.statePlaneZone) {
      html += '<div class="rec-zone-callout"><span class="data-code amber">SPCS Zone</span> <span class="data-name">' + esc(rec.statePlaneZone.zoneName) + '</span></div>';
    }

    // Horizontal CRS
    html += '<div class="rec-group">';
    html += '<div class="rec-group-title">Projected / Horizontal CRS</div>';
    rec.horizontal.forEach(function(h) {
      if (!h) return;
      html += '<div class="rec-entry">';
      html += '<span class="data-code teal">' + esc(h.code) + '</span> ';
      html += '<span class="data-name">' + esc(h.name) + '</span>';
      if (h.link) html += ' <a href="' + esc(h.link) + '" target="_blank" rel="noopener" class="data-link">View →</a>';
      html += '</div>';
    });
    html += '</div>';

    // Vertical Datums
    if (rec.vertical.length > 0) {
      html += '<div class="rec-group">';
      html += '<div class="rec-group-title">Vertical Datums</div>';
      rec.vertical.forEach(function(v) {
        if (!v) return;
        html += '<div class="rec-entry">';
        html += '<span class="data-code coral">' + esc(v.code) + '</span> ';
        html += '<span class="data-name">' + esc(v.name) + '</span>';
        if (v.link) html += ' <a href="' + esc(v.link) + '" target="_blank" rel="noopener" class="data-link">View →</a>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Geoid Model
    if (rec.geoid && rec.geoid.length > 0) {
      html += '<div class="rec-group">';
      html += '<div class="rec-group-title">Recommended Geoid Model</div>';
      rec.geoid.forEach(function(g) {
        if (!g) return;
        html += '<div class="rec-entry">';
        html += '<span class="data-code teal">' + esc(g.code) + '</span> ';
        html += '<span class="data-name">' + esc(g.name) + '</span>';
        html += '<div class="data-desc">' + esc(g.description) + '</div>';
        if (g.link) html += '<a href="' + esc(g.link) + '" target="_blank" rel="noopener" class="data-link">More info →</a>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Ellipsoid
    if (rec.ellipsoid && rec.ellipsoid.length > 0) {
      html += '<div class="rec-group">';
      html += '<div class="rec-group-title">Reference Ellipsoid</div>';
      rec.ellipsoid.forEach(function(e) {
        if (!e) return;
        html += '<div class="rec-entry">';
        html += '<span class="data-code slate">' + esc(e.code) + '</span> ';
        html += '<span class="data-name">' + esc(e.name) + '</span>';
        if (e.link) html += ' <a href="' + esc(e.link) + '" target="_blank" rel="noopener" class="data-link">View →</a>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Unit variants
    html += '<div class="rec-group">';
    html += '<div class="rec-group-title">Unit Options</div>';
    if (rec.units.us.length > 0) {
      html += '<div class="rec-sub-title">US Survey Feet (ftUS)</div>';
      rec.units.us.slice(0, 3).forEach(function(u) {
        html += '<div class="rec-entry"><span class="data-code">' + esc(u.code) + '</span> <span class="data-name">' + esc(u.name) + '</span></div>';
      });
    }
    if (rec.units.metric.length > 0) {
      html += '<div class="rec-sub-title">Metric (meters)</div>';
      rec.units.metric.slice(0, 3).forEach(function(m) {
        html += '<div class="rec-entry"><span class="data-code">' + esc(m.code) + '</span> <span class="data-name">' + esc(m.name) + '</span></div>';
      });
    }
    html += '</div>';

    div.innerHTML = html;
    return div;
  }

  function renderCRSItem(item) {
    const div = document.createElement('div');
    div.className = 'data-item';
    const codeClass = item.kind && item.kind.includes('PROJCRS') ? 'teal' : item.kind && item.kind.includes('DATUM') ? 'coral' : item.kind && item.kind.includes('ELLIPSOID') ? 'slate' : '';

    div.innerHTML = 
      '<div class="data-item-header">' +
        '<span class="data-code ' + codeClass + '">' + esc(item.code) + '</span>' +
        '<span class="data-name">' + esc(item.name) + '</span>' +
      '</div>' +
      (item.area ? '<div class="data-desc">Area of use: ' + esc(item.area) + '</div>' : '') +
      '<a href="' + esc(item.link) + '" target="_blank" rel="noopener" class="data-link">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
        ' View on epsg.io →' +
      '</a>';
    return div;
  }

  function renderGeoidItem(item) {
    const div = document.createElement('div');
    div.className = 'data-item';
    div.innerHTML = 
      '<div class="data-item-header">' +
        '<span class="data-code teal">' + esc(item.code) + '</span>' +
        '<span class="data-name">' + esc(item.name) + '</span>' +
      '</div>' +
      '<div class="data-desc">' + esc(item.description) + '</div>' +
      '<div class="data-tags">' + item.tags.map(t => '<span class="data-tag">' + esc(t) + '</span>').join('') + '</div>' +
      '<a href="' + esc(item.link) + '" target="_blank" rel="noopener" class="data-link">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
        ' More info →' +
      '</a>';
    return div;
  }

  function renderSourceItem(item) {
    const div = document.createElement('div');
    div.className = 'data-item';
    div.innerHTML = 
      '<div class="data-item-header">' +
        '<span class="data-code slate">' + esc(item.provider) + '</span>' +
        '<span class="data-name">' + esc(item.name) + '</span>' +
      '</div>' +
      '<div class="data-desc">' + esc(item.description) + '</div>' +
      '<div class="data-tags">' + (item.tags || []).map(t => '<span class="data-tag">' + esc(t) + '</span>').join('') + '</div>' +
      '<a href="' + esc(item.link) + '" target="_blank" rel="noopener" class="data-link">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
        ' Access data →' +
      '</a>';
    return div;
  }

  function renderBaseStationItem(item) {
    var div = document.createElement('div');
    div.className = 'data-item';
    var colorStyle = item.color ? ' style="background:' + item.color + '22; color:' + item.color + '"' : '';
    var distHtml = '';
    if (item.distanceM !== null) {
      var dKm = (item.distanceM / 1000).toFixed(1);
      var dMi = (item.distanceM / 1609.344).toFixed(1);
      distHtml = '<span class="station-distance">' + dMi + ' mi / ' + dKm + ' km</span>';
    }
    div.innerHTML =
      '<div class="data-item-header">' +
        '<span class="data-code"' + colorStyle + '>' + esc(item.provider) + '</span>' +
        '<span class="data-name">' + esc(item.name) + '</span>' +
        distHtml +
      '</div>' +
      (item.stationId ? '<div class="data-desc">Station ID: ' + esc(item.stationId) + (item.lat !== null ? ' · ' + item.lat.toFixed(5) + '°, ' + item.lon.toFixed(5) + '°' : '') + '</div>' : '') +
      '<div class="data-desc">' + esc(item.description) + '</div>' +
      '<div class="data-tags">' + (item.tags || []).map(function(t) { return '<span class="data-tag">' + esc(t) + '</span>'; }).join('') + '</div>' +
      '<a href="' + esc(item.link) + '" target="_blank" rel="noopener" class="data-link">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
        ' Access data →' +
      '</a>';
    return div;
  }

  // ── Utilities ───────────────────────────────────────
  async function fetchJSON(url, extraHeaders) {
    if (extraHeaders === undefined) extraHeaders = {};
    const headers = { 
      'Accept': 'application/json', 
      'User-Agent': 'WhatsHere/1.0[](https://github.com/JustinKMarlowe/whats_here)',
    };
    Object.assign(headers, extraHeaders);
    const resp = await fetch(url, { headers: headers });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
    return resp.json();
  }

  function esc(str) {
    if (!str) return '';
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

})();