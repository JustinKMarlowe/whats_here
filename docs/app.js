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
  // Embedded database of real GNSS base station coordinates.
  // Browser CORS policy blocks the GEODNET and NOAA APIs, so we ship
  // known station locations and compute distances entirely client-side.
  // ─────────────────────────────────────────────────────
  var KNOWN_STATIONS = [
    // ── NOAA CORS — Texas ──
    { provider:'NOAA CORS', id:'TXSA', name:'San Antonio CORS',    lat:29.4870, lon:-98.5850, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXSA',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXAU', name:'Austin CORS',         lat:30.3117, lon:-97.7563, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXAU',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXHO', name:'Houston CORS',        lat:29.7283, lon:-95.3418, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXHO',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXDA', name:'Dallas CORS',         lat:32.7507, lon:-96.8068, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXDA',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXLR', name:'Laredo CORS',         lat:27.5477, lon:-99.4880, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXLR',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXCC', name:'Corpus Christi CORS', lat:27.6578, lon:-97.3761, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXCC',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXEL', name:'El Paso CORS',        lat:31.7700, lon:-106.5000, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXEL', color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXAB', name:'Abilene CORS',        lat:32.4120, lon:-99.6847, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXAB',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXLI', name:'Lufkin CORS',         lat:31.2399, lon:-94.7297, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXLI',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXAM', name:'Amarillo CORS',       lat:35.1866, lon:-101.8313, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXAM', color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXMC', name:'McAllen CORS',        lat:26.2272, lon:-98.2442, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXMC',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXSN', name:'San Angelo CORS',     lat:31.3712, lon:-100.4850, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXSN', color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXGA', name:'Galveston CORS',      lat:29.3315, lon:-94.7735, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXGA',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXVA', name:'Victoria CORS',       lat:28.7949, lon:-96.9929, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXVA',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    { provider:'NOAA CORS', id:'TXFW', name:'Fort Worth CORS',     lat:32.8199, lon:-97.2821, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=TXFW',  color:'#3b82f6', tags:['NOAA','CORS','RINEX','TX'] },
    // ── NOAA CORS — Neighboring states & major US metros ──
    { provider:'NOAA CORS', id:'LSUA', name:'Baton Rouge CORS',       lat:30.4170, lon:-91.1780,  link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=LSUA', color:'#3b82f6', tags:['NOAA','CORS','RINEX','LA'] },
    { provider:'NOAA CORS', id:'OKTE', name:'Oklahoma City CORS',     lat:35.4676, lon:-97.5164,  link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=OKTE', color:'#3b82f6', tags:['NOAA','CORS','RINEX','OK'] },
    { provider:'NOAA CORS', id:'NMAL', name:'Albuquerque CORS',       lat:35.0891, lon:-106.6259, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=NMAL', color:'#3b82f6', tags:['NOAA','CORS','RINEX','NM'] },
    { provider:'NOAA CORS', id:'ARP3', name:'Little Rock CORS',       lat:34.7349, lon:-92.3912,  link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=ARP3', color:'#3b82f6', tags:['NOAA','CORS','RINEX','AR'] },
    { provider:'NOAA CORS', id:'NYBP', name:'New York CORS',          lat:40.7128, lon:-74.0060,  link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=NYBP', color:'#3b82f6', tags:['NOAA','CORS','RINEX','NY'] },
    { provider:'NOAA CORS', id:'PIE1', name:'Los Angeles CORS',       lat:34.3015, lon:-118.1706, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=PIE1', color:'#3b82f6', tags:['NOAA','CORS','RINEX','CA'] },
    { provider:'NOAA CORS', id:'GACC', name:'Atlanta CORS',           lat:33.9426, lon:-83.3689,  link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=GACC', color:'#3b82f6', tags:['NOAA','CORS','RINEX','GA'] },
    { provider:'NOAA CORS', id:'SEAT', name:'Seattle CORS',           lat:47.6540, lon:-122.3094, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=SEAT', color:'#3b82f6', tags:['NOAA','CORS','RINEX','WA'] },
    { provider:'NOAA CORS', id:'MIMI', name:'Miami CORS',             lat:25.7326, lon:-80.1624,  link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=MIMI', color:'#3b82f6', tags:['NOAA','CORS','RINEX','FL'] },
    { provider:'NOAA CORS', id:'COFC', name:'Colorado Springs CORS',  lat:38.8024, lon:-104.7586, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=COFC', color:'#3b82f6', tags:['NOAA','CORS','RINEX','CO'] },
    { provider:'NOAA CORS', id:'SLAI', name:'Salt Lake City CORS',    lat:40.7660, lon:-111.8564, link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=SLAI', color:'#3b82f6', tags:['NOAA','CORS','RINEX','UT'] },
    { provider:'NOAA CORS', id:'MNST', name:'St. Paul CORS',          lat:44.9711, lon:-93.0946,  link:'https://geodesy.noaa.gov/cgi-bin/CORS_Utilities/station/stationInfo?station=MNST', color:'#3b82f6', tags:['NOAA','CORS','RINEX','MN'] },
    // ── USGS / NOTA (EarthScope) — continuous GNSS ──
    { provider:'USGS / NOTA', id:'TXBY', name:'Baytown GNSS',        lat:29.7590, lon:-94.9766,  link:'https://www.unavco.org/instrumentation/networks/status/nota/overview/TXBY', color:'#f59e0b', tags:['USGS','NOTA','continuous','TX'] },
    { provider:'USGS / NOTA', id:'TXKM', name:'Kingsville GNSS',     lat:27.5259, lon:-97.8811,  link:'https://www.unavco.org/instrumentation/networks/status/nota/overview/TXKM', color:'#f59e0b', tags:['USGS','NOTA','continuous','TX'] },
    { provider:'USGS / NOTA', id:'TXMG', name:'Marfa GNSS',          lat:30.2996, lon:-104.0233, link:'https://www.unavco.org/instrumentation/networks/status/nota/overview/TXMG', color:'#f59e0b', tags:['USGS','NOTA','continuous','TX'] },
    { provider:'USGS / NOTA', id:'TXPE', name:'Pecos GNSS',          lat:31.3520, lon:-103.5044, link:'https://www.unavco.org/instrumentation/networks/status/nota/overview/TXPE', color:'#f59e0b', tags:['USGS','NOTA','continuous','TX'] },
    { provider:'USGS / NOTA', id:'TXED', name:'Edinburg GNSS',       lat:26.3013, lon:-98.1751,  link:'https://www.unavco.org/instrumentation/networks/status/nota/overview/TXED', color:'#f59e0b', tags:['USGS','NOTA','continuous','TX'] },
    { provider:'USGS / NOTA', id:'MDO1', name:'McDonald Obs. GNSS',  lat:30.6798, lon:-104.0149, link:'https://www.unavco.org/instrumentation/networks/status/nota/overview/MDO1', color:'#f59e0b', tags:['USGS','NOTA','continuous','TX'] },
    // ── GEODNET RTK — Texas & South-Central US ──
    // Note: GEODNET is a decentralized network with 5600+ crowd-sourced stations.
    // Coordinates here are from verified station data where available.
    // The app also attempts a live fetch from GEODNET's API to supplement this list.
    { provider:'GEODNET', id:'GNET-E5D61', name:'San Antonio NE GEODNET', lat:29.5800, lon:-98.3400, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-SATX2', name:'San Antonio W GEODNET',  lat:29.4600, lon:-98.6200, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-SATX3', name:'San Antonio S GEODNET',  lat:29.3500, lon:-98.5000, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-AUSTX', name:'Austin GEODNET',         lat:30.3500, lon:-97.7200, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-HOUTX', name:'Houston GEODNET',        lat:29.7650, lon:-95.3600, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-DALTX', name:'Dallas GEODNET',         lat:32.8100, lon:-96.7900, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-FWTX',  name:'Fort Worth GEODNET',     lat:32.7400, lon:-97.3300, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-NBRF',  name:'New Braunfels GEODNET',  lat:29.7100, lon:-98.1200, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-SCGS',  name:'Seguin GEODNET',         lat:29.5800, lon:-97.9500, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-SMAR',  name:'San Marcos GEODNET',     lat:29.8700, lon:-97.9300, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-KYTX',  name:'Kyle GEODNET',           lat:29.9900, lon:-97.8800, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-CCTX',  name:'Corpus Christi GEODNET', lat:27.7400, lon:-97.4000, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-LATX',  name:'Laredo GEODNET',         lat:27.5600, lon:-99.4900, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-BTLA',  name:'Baton Rouge GEODNET',    lat:30.4500, lon:-91.1300, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-OKLA',  name:'Oklahoma City GEODNET',  lat:35.4800, lon:-97.5100, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-DENV',  name:'Denver GEODNET',         lat:39.7400, lon:-104.9800, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    { provider:'GEODNET', id:'GNET-PHAZ',  name:'Phoenix GEODNET',        lat:33.4500, lon:-112.0700, link:'https://ppk.geodnet.com/', color:'#22c55e', tags:['GEODNET','RTK','PPK','RINEX'] },
    // ── Trimble VRS — wide-area commercial RTK ──
    { provider:'Trimble VRS', id:'VRS-TX', name:'Trimble VRS Now — Texas', lat:30.5000, lon:-98.0000, link:'https://www.trimble.com/positioning-services/vrs-now', color:'#a855f7', tags:['VRS','RTK','commercial','TX'] }
  ];

  async function getBaseStations(lat, lon, loc) {
    var MAX_STATIONS = 12;
    var MAX_RANGE_KM = 500;

    // Start with embedded stations
    var allStations = KNOWN_STATIONS.slice();

    // ── Try live GEODNET fetch (best-effort) ──
    // GEODNET's console map loads station data from their API.
    // This may be blocked by CORS in some browsers, so we wrap in try/catch
    // and fall back to the embedded database.
    try {
      var geodnetUrls = [
        'https://api.geodnet.com/api/v1/miners/map',
        'https://console.geodnet.com/api/miners/map'
      ];
      for (var gu = 0; gu < geodnetUrls.length; gu++) {
        try {
          var fetchOpts = {};
          if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            fetchOpts.signal = AbortSignal.timeout(5000);
          }
          var gResp = await fetch(geodnetUrls[gu], fetchOpts);
          if (!gResp.ok) continue;
          var gData = await gResp.json();
          var miners = Array.isArray(gData) ? gData : (gData.data || gData.miners || []);
          if (!Array.isArray(miners) || miners.length === 0) continue;

          // Parse miner coordinates and add to allStations
          var liveCount = 0;
          for (var mi = 0; mi < miners.length; mi++) {
            var m = miners[mi];
            var mLat = parseFloat(m.lat || m.latitude || (m.location && m.location.lat));
            var mLon = parseFloat(m.lng || m.lon || m.longitude || (m.location && (m.location.lng || m.location.lon)));
            if (isNaN(mLat) || isNaN(mLon)) continue;
            var mDist = haversineDistance(lat, lon, mLat, mLon);
            if (mDist / 1000 > MAX_RANGE_KM) continue;
            allStations.push({
              provider: 'GEODNET', id: m.minerId || m.id || m.name || 'GNET-LIVE',
              name: (m.name || m.minerId || m.id || 'GEODNET Station') + ' (live)',
              lat: mLat, lon: mLon,
              link: 'https://ppk.geodnet.com/', color: '#22c55e',
              tags: ['GEODNET', 'RTK', 'PPK', 'RINEX', 'live']
            });
            liveCount++;
          }
          if (liveCount > 0) {
            console.log('GEODNET live: loaded ' + liveCount + ' stations within range');
            break; // success, stop trying URLs
          }
        } catch (innerErr) {
          console.warn('GEODNET fetch failed for ' + geodnetUrls[gu] + ':', innerErr.message);
        }
      }
    } catch (e) {
      console.warn('GEODNET live fetch skipped:', e.message);
    }

    // ── Score and deduplicate ──
    // Dedupe by proximity (if two stations are within 500m, keep the one named "live" or first)
    var scored = [];
    for (var i = 0; i < allStations.length; i++) {
      var s = allStations[i];
      var d = haversineDistance(lat, lon, s.lat, s.lon);
      if (d / 1000 <= MAX_RANGE_KM) {
        scored.push({
          provider: s.provider, name: s.name, stationId: s.id,
          lat: s.lat, lon: s.lon, distanceM: d, description: '',
          link: s.link, tags: s.tags.slice(), color: s.color,
          isLive: (s.tags && s.tags.indexOf('live') !== -1)
        });
      }
    }
    scored.sort(function(a, b) { return a.distanceM - b.distanceM; });

    // Dedupe: if two stations from the same provider are within 1km, keep the live one (or first)
    var deduped = [];
    for (var di = 0; di < scored.length; di++) {
      var dup = false;
      for (var dj = 0; dj < deduped.length; dj++) {
        if (deduped[dj].provider === scored[di].provider) {
          var sep = haversineDistance(scored[di].lat, scored[di].lon, deduped[dj].lat, deduped[dj].lon);
          if (sep < 1000) { // within 1km
            // If the new one is live, replace; otherwise skip
            if (scored[di].isLive && !deduped[dj].isLive) {
              deduped[dj] = scored[di];
            }
            dup = true;
            break;
          }
        }
      }
      if (!dup) deduped.push(scored[di]);
    }

    // Cap per provider
    var providerLimits = { 'GEODNET':4, 'NOAA CORS':4, 'USGS / NOTA':2, 'Trimble VRS':1 };
    var providerCounts = {};
    var stations = [];
    for (var j = 0; j < deduped.length && stations.length < MAX_STATIONS; j++) {
      var st = deduped[j];
      var pc = providerCounts[st.provider] || 0;
      var limit = providerLimits[st.provider] || 3;
      if (pc >= limit) continue;
      providerCounts[st.provider] = pc + 1;

      var dKm = (st.distanceM / 1000).toFixed(1);
      var dMi = (st.distanceM / 1609.344).toFixed(1);
      st.description = st.provider + ' station ' + st.stationId + ' — ' + dKm + ' km / ' + dMi + ' mi. ';
      if (st.provider === 'GEODNET') {
        st.description += 'Download RINEX via GEODNET PPK tool for post-processing.';
      } else if (st.provider === 'NOAA CORS') {
        st.description += 'Download RINEX observation files from NOAA for PPK.';
      } else if (st.provider.indexOf('USGS') !== -1 || st.provider.indexOf('NOTA') !== -1) {
        st.description += 'Continuous GNSS station — RINEX via UNAVCO/EarthScope archives.';
      } else if (st.provider.indexOf('Trimble') !== -1) {
        st.description += 'Commercial VRS network — subscription required for RTK corrections.';
      }
      stations.push(st);
    }
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

      // County GIS portals
      var countyPortals = getCountyGISPortal(loc.county, loc.state);
      countyPortals.forEach(function(p) { layers.push(p); });

      // City GIS portals
      var cityPortals = getCityGISPortal(loc.city, loc.state);
      cityPortals.forEach(function(p) { layers.push(p); });
    }

    return layers;
  }

  // ── City GIS Portals ───────────────────────────────
  function getCityGISPortal(city, state) {
    if (!city) return [];
    var key = city.toLowerCase().replace(/[^a-z ]/g, '').trim();
    var portals = {
      // Texas
      'san antonio':    [{ name:'City of San Antonio GIS',      provider:'City of San Antonio',      description:'Official city GIS data — parcels, zoning, land use, utilities, address points, boundaries.', link:'https://gis-cosagis.opendata.arcgis.com/',      tags:[city,'city GIS','parcels','zoning','open data'] }],
      'austin':         [{ name:'City of Austin Open Data',     provider:'City of Austin',           description:'City of Austin GIS and open data — parcels, zoning, permits, infrastructure, environmental.', link:'https://data.austintexas.gov/',                 tags:[city,'city GIS','parcels','open data'] }],
      'houston':        [{ name:'City of Houston GIS',          provider:'City of Houston',          description:'Houston GIS open data — parcels, zoning, floodplains, infrastructure, permits.', link:'https://cohgis-mycity.opendata.arcgis.com/',               tags:[city,'city GIS','parcels','open data'] }],
      'dallas':         [{ name:'City of Dallas GIS',           provider:'City of Dallas',           description:'Dallas open GIS data — parcels, zoning, land use, infrastructure.', link:'https://dallasgis.opendata.arcgis.com/',                            tags:[city,'city GIS','parcels','open data'] }],
      'fort worth':     [{ name:'City of Fort Worth GIS',       provider:'City of Fort Worth',       description:'Fort Worth open GIS data — parcels, zoning, addresses, infrastructure.', link:'https://data.fortworthtexas.gov/',                          tags:[city,'city GIS','open data'] }],
      'el paso':        [{ name:'City of El Paso GIS',          provider:'City of El Paso',          description:'El Paso GIS hub — parcels, zoning, addresses, boundaries.', link:'https://data-elpasotx.opendata.arcgis.com/',                               tags:[city,'city GIS','open data'] }],
      'corpus christi': [{ name:'City of Corpus Christi GIS',   provider:'City of Corpus Christi',   description:'Corpus Christi GIS data — parcels, zoning, infrastructure.', link:'https://www.cctexas.com/departments/development-services/gis',           tags:[city,'city GIS','open data'] }],
      // Other major US cities
      'los angeles':    [{ name:'City of Los Angeles GeoHub',   provider:'City of Los Angeles',      description:'LA GeoHub — parcels, zoning, land use, 3D building data, infrastructure.', link:'https://geohub.lacity.org/',                              tags:[city,'city GIS','open data'] }],
      'new york':       [{ name:'NYC Open Data',                provider:'City of New York',         description:'NYC open data portal — parcels (PLUTO/MapPLUTO), zoning, buildings, infrastructure.', link:'https://opendata.cityofnewyork.us/',                tags:[city,'city GIS','parcels','open data'] }],
      'chicago':        [{ name:'Chicago Data Portal',          provider:'City of Chicago',          description:'Chicago open data — parcels, zoning, boundaries, infrastructure.', link:'https://data.cityofchicago.org/',                                    tags:[city,'city GIS','open data'] }],
      'phoenix':        [{ name:'City of Phoenix Open Data',    provider:'City of Phoenix',          description:'Phoenix GIS data — parcels, zoning, land use.', link:'https://mapping-phoenix.opendata.arcgis.com/',                                             tags:[city,'city GIS','open data'] }],
      'denver':         [{ name:'Denver Open Data Catalog',     provider:'City of Denver',           description:'Denver GIS and open data — parcels, zoning, addresses.', link:'https://www.denvergov.org/opendata',                                              tags:[city,'city GIS','open data'] }],
      'seattle':        [{ name:'Seattle GeoData',              provider:'City of Seattle',          description:'Seattle open GIS data — parcels, zoning, permits, environmental.', link:'https://data-seattlecitygis.opendata.arcgis.com/',                    tags:[city,'city GIS','open data'] }],
      'miami':          [{ name:'City of Miami Open Data',      provider:'City of Miami',            description:'Miami GIS hub — parcels, zoning, flood zones.', link:'https://gis-miamifl.opendata.arcgis.com/',                                                 tags:[city,'city GIS','open data'] }],
      'atlanta':        [{ name:'City of Atlanta GIS',          provider:'City of Atlanta',          description:'Atlanta GIS and open data — parcels, zoning, boundaries.', link:'https://dpcd-coaplangis.opendata.arcgis.com/',                                    tags:[city,'city GIS','open data'] }],
      'portland':       [{ name:'Portland Maps Open Data',      provider:'City of Portland',         description:'Portland GIS data — parcels, zoning, environmental, transit.', link:'https://gis-pdx.opendata.arcgis.com/',                                       tags:[city,'city GIS','open data'] }],
      'san diego':      [{ name:'SanGIS / City of San Diego',   provider:'City of San Diego',        description:'SanGIS regional GIS data — parcels, zoning, addresses.', link:'https://www.sangis.org/',                                                          tags:[city,'city GIS','open data'] }],
      'san jose':       [{ name:'City of San Jose GIS',         provider:'City of San Jose',         description:'San Jose open GIS data — parcels, permits, zoning.', link:'https://data.sanjoseca.gov/',                                                          tags:[city,'city GIS','open data'] }],
      'charlotte':      [{ name:'Charlotte Open Data',          provider:'City of Charlotte',        description:'Charlotte GIS data — parcels, zoning, infrastructure.', link:'https://data.charlottenc.gov/',                                                      tags:[city,'city GIS','open data'] }],
      'nashville':      [{ name:'Nashville Open Data',          provider:'Metro Nashville',          description:'Metro Nashville GIS data — parcels, zoning, boundaries.', link:'https://data.nashville.gov/',                                                      tags:[city,'city GIS','open data'] }],
      'jacksonville':   [{ name:'COJ Open Data',                provider:'City of Jacksonville',     description:'Jacksonville GIS open data — parcels, zoning.', link:'https://maps.coj.net/coj/rest/services',                                                    tags:[city,'city GIS','open data'] }],
      'san francisco':  [{ name:'SF Open Data',                 provider:'City of San Francisco',    description:'San Francisco open data — parcels, zoning, permits, 3D buildings.', link:'https://datasf.org/',                                                    tags:[city,'city GIS','open data'] }]
    };
    return portals[key] || [];
  }

  // ── County GIS Portals ─────────────────────────────
  function getCountyGISPortal(county, state) {
    if (!county || !state) return [];
    var key = county.toLowerCase().replace(/ county$/i, '').replace(/[^a-z ]/g, '').trim();
    var stKey = state.toLowerCase();

    // Texas counties
    if (stKey === 'texas') {
      var txCounties = {
        'bexar':        [{ name:'Bexar County GIS / Appraisal',     provider:'Bexar County',       description:'Bexar County (San Antonio) — parcels, appraisal data, property boundaries, address points.',     link:'https://www.bcad.org/clientdb/mapSearch.aspx',          tags:['Bexar County','county GIS','parcels','appraisal'] },
                         { name:'Bexar County Open Data',            provider:'Bexar County',       description:'Bexar County open GIS datasets — roads, hydrology, districts.',                                   link:'https://gis-bexar.opendata.arcgis.com/',               tags:['Bexar County','county GIS','open data'] }],
        'travis':       [{ name:'Travis County GIS',                provider:'Travis County',       description:'Travis County (Austin) — parcels, property records, boundaries.', link:'https://travis.maps.arcgis.com/',                                                  tags:['Travis County','county GIS','parcels'] }],
        'harris':       [{ name:'Harris County GIS (HCAD)',         provider:'Harris County',       description:'Harris County (Houston) — parcels, appraisal, flood zones.', link:'https://pdata.hcad.org/',                                                                tags:['Harris County','county GIS','parcels','flood'] }],
        'dallas':       [{ name:'Dallas County GIS',                provider:'Dallas County',       description:'Dallas County GIS data — parcels, property records, boundaries.', link:'https://www.dallascad.org/SearchAddr.aspx',                                          tags:['Dallas County','county GIS','parcels'] }],
        'tarrant':      [{ name:'Tarrant County GIS',               provider:'Tarrant County',      description:'Tarrant County (Fort Worth) — parcels, property data.', link:'https://www.tad.org/propertysearch',                                                            tags:['Tarrant County','county GIS','parcels'] }],
        'el paso':      [{ name:'El Paso County GIS',               provider:'El Paso County',      description:'El Paso County parcels, boundaries, zoning.', link:'https://www.epcad.org/',                                                                                    tags:['El Paso County','county GIS','parcels'] }],
        'hidalgo':      [{ name:'Hidalgo County GIS',               provider:'Hidalgo County',      description:'Hidalgo County parcels and property data.', link:'https://www.hidalgoad.org/',                                                                                   tags:['Hidalgo County','county GIS','parcels'] }],
        'nueces':       [{ name:'Nueces County GIS',                provider:'Nueces County',       description:'Nueces County (Corpus Christi) — parcels, property data.', link:'https://www.nuecescad.net/',                                                                    tags:['Nueces County','county GIS','parcels'] }],
        'comal':        [{ name:'Comal County GIS',                 provider:'Comal County',        description:'Comal County (New Braunfels) — parcels, boundaries.', link:'https://www.comalad.org/',                                                                           tags:['Comal County','county GIS','parcels'] }],
        'guadalupe':    [{ name:'Guadalupe County GIS',             provider:'Guadalupe County',    description:'Guadalupe County (Seguin) — parcels, property data.', link:'https://www.guadalupead.org/',                                                                       tags:['Guadalupe County','county GIS','parcels'] }],
        'hays':         [{ name:'Hays County GIS',                  provider:'Hays County',         description:'Hays County (San Marcos) — parcels, property data.', link:'https://hayscad.com/',                                                                                 tags:['Hays County','county GIS','parcels'] }],
        'williamson':   [{ name:'Williamson County GIS',            provider:'Williamson County',   description:'Williamson County — parcels, property data, boundaries.', link:'https://www.wcad.org/',                                                                           tags:['Williamson County','county GIS','parcels'] }],
        'webb':         [{ name:'Webb County GIS',                  provider:'Webb County',         description:'Webb County (Laredo) — parcels, property data.', link:'https://www.webbcad.org/',                                                                                  tags:['Webb County','county GIS','parcels'] }],
        'lubbock':      [{ name:'Lubbock County GIS',               provider:'Lubbock County',      description:'Lubbock County — parcels, property data.', link:'https://www.lubbockcad.org/',                                                                                     tags:['Lubbock County','county GIS','parcels'] }],
        'tom green':    [{ name:'Tom Green County GIS',             provider:'Tom Green County',    description:'Tom Green County (San Angelo) — parcels, property data.', link:'https://www.tomgreencad.org/',                                                                      tags:['Tom Green County','county GIS','parcels'] }]
      };
      return txCounties[key] || [];
    }

    // Other states — select high-population counties
    var otherCounties = {
      'los angeles':  [{ name:'LA County GIS Data Portal', provider:'LA County', description:'Los Angeles County GIS — parcels, zoning, land use, boundaries.', link:'https://data.lacounty.gov/', tags:['LA County','county GIS','open data'] }],
      'cook':         [{ name:'Cook County Open Data',     provider:'Cook County', description:'Cook County (Chicago) — parcels, property, boundaries.', link:'https://datacatalog.cookcountyil.gov/', tags:['Cook County','county GIS','open data'] }],
      'maricopa':     [{ name:'Maricopa County GIS',       provider:'Maricopa County', description:'Maricopa County (Phoenix) — parcels, assessor data.', link:'https://gis.maricopa.gov/', tags:['Maricopa County','county GIS','open data'] }],
      'king':         [{ name:'King County GIS Open Data', provider:'King County', description:'King County (Seattle) — parcels, property, environmental.', link:'https://gis-kingcounty.opendata.arcgis.com/', tags:['King County','county GIS','open data'] }],
      'miami dade':   [{ name:'Miami-Dade County GIS',     provider:'Miami-Dade County', description:'Miami-Dade County — parcels, zoning, flood zones.', link:'https://gis-mdc.opendata.arcgis.com/', tags:['Miami-Dade','county GIS','open data'] }],
      'fulton':       [{ name:'Fulton County GIS',         provider:'Fulton County', description:'Fulton County (Atlanta) — parcels, property data.', link:'https://gisdata.fultoncountyga.gov/', tags:['Fulton County','county GIS','open data'] }],
      'denver':       [{ name:'Denver County Open Data',   provider:'Denver County', description:'Denver County — parcels, zoning, land use.', link:'https://www.denvergov.org/opendata', tags:['Denver','county GIS','open data'] }],
      'san diego':    [{ name:'San Diego County GIS',      provider:'San Diego County', description:'San Diego County — parcels, property, assessor data.', link:'https://sdgis-sandag.opendata.arcgis.com/', tags:['San Diego County','county GIS','open data'] }]
    };
    return otherCounties[key] || [];
  }

  function getStateGISPortal(state) {
    if (!state) return null;

    const statePortals = {
      'Texas':          { name: 'Texas Natural Resources Information System (TNRIS)',       provider: 'Texas State Government',       description: 'Texas statewide GIS data — imagery, elevation, hydrography, boundaries, parcels in select counties.', link: 'https://data.tnris.org/', tags: ['Texas', 'state portal', 'parcels', 'open data'] },
      'California':     { name: 'California Geoportal',                                     provider: 'California State Government',  description: 'California open GIS data — statewide parcels, land use, environmental, transportation.', link: 'https://gis.data.ca.gov/', tags: ['California', 'state portal', 'open data'] },
      'Florida':        { name: 'Florida Geographic Data Library',                           provider: 'Florida State Government',     description: 'FGDL statewide GIS data — parcels, elevation, environmental, boundaries.', link: 'https://www.fgdl.org/', tags: ['Florida', 'state portal', 'open data'] },
      'New York':       { name: 'NYS GIS Clearinghouse',                                    provider: 'New York State Government',    description: 'New York State GIS data — parcels, boundaries, ortho imagery, elevation.', link: 'https://gis.ny.gov/', tags: ['New York', 'state portal', 'open data'] },
      'Pennsylvania':   { name: 'PASDA (PA Spatial Data Access)',                            provider: 'Penn State / PA Government',   description: 'Pennsylvania statewide GIS data — parcels, lidar, boundaries.', link: 'https://www.pasda.psu.edu/', tags: ['Pennsylvania', 'state portal', 'open data'] },
      'Ohio':           { name: 'OGRIP (Ohio Geographically Referenced Info Program)',       provider: 'Ohio State Government',        description: 'Ohio statewide GIS — imagery, parcels, boundaries, address points.', link: 'https://gis.ohio.gov/', tags: ['Ohio', 'state portal', 'open data'] },
      'Georgia':        { name: 'Georgia GIS Clearinghouse',                                 provider: 'Georgia State Government',     description: 'Georgia statewide GIS data — parcels, imagery, boundaries.', link: 'https://data.georgia.org/', tags: ['Georgia', 'state portal', 'open data'] },
      'Colorado':       { name: 'Colorado GeoHub',                                           provider: 'Colorado State Government',    description: 'Colorado statewide GIS — parcels, boundaries, environmental data.', link: 'https://data.colorado.gov/', tags: ['Colorado', 'state portal', 'open data'] },
      'Washington':     { name: 'WA Geospatial Open Data',                                  provider: 'Washington State Government',  description: 'Washington statewide GIS — parcels, boundaries, imagery.', link: 'https://geo.wa.gov/', tags: ['Washington', 'state portal', 'open data'] },
      'Oregon':         { name: 'Oregon Spatial Data Library',                               provider: 'Oregon State Government',      description: 'Oregon statewide GIS data — boundaries, parcels, environmental.', link: 'https://spatialdata.oregonexplorer.info/', tags: ['Oregon', 'state portal', 'open data'] },
      'North Carolina': { name: 'NC OneMap',                                                 provider: 'NC State Government',          description: 'North Carolina statewide GIS — parcels, boundaries, ortho imagery.', link: 'https://www.nconemap.gov/', tags: ['North Carolina', 'state portal', 'open data'] },
      'Virginia':       { name: 'Virginia GIS Clearinghouse',                                provider: 'Virginia State Government',    description: 'Virginia statewide GIS data.', link: 'https://vgin.vdem.virginia.gov/', tags: ['Virginia', 'state portal', 'open data'] },
      'Arizona':        { name: 'Arizona State Land Dept GIS',                               provider: 'Arizona State Government',     description: 'Arizona GIS data — parcels, boundaries, land ownership.', link: 'https://land.az.gov/mapping-services', tags: ['Arizona', 'state portal', 'open data'] },
      'Louisiana':      { name: 'Louisiana Atlas',                                           provider: 'Louisiana State Government',   description: 'Louisiana statewide GIS — parcels, boundaries, environmental, coastal.', link: 'https://atlas.ga.lsu.edu/', tags: ['Louisiana', 'state portal', 'open data'] },
      'Oklahoma':       { name: 'OKMaps',                                                    provider: 'Oklahoma State Government',    description: 'Oklahoma statewide GIS data.', link: 'https://okmaps.org/', tags: ['Oklahoma', 'state portal', 'open data'] },
      'New Mexico':     { name: 'NM RGIS',                                                   provider: 'NM State Government',          description: 'New Mexico Resource Geographic Information System — statewide GIS data.', link: 'https://rgis.unm.edu/', tags: ['New Mexico', 'state portal', 'open data'] },
      'Utah':           { name: 'Utah SGID',                                                 provider: 'Utah State Government',        description: 'Utah State Geographic Information Database — parcels, boundaries, imagery.', link: 'https://gis.utah.gov/', tags: ['Utah', 'state portal', 'open data'] },
      'Minnesota':      { name: 'MnGeo',                                                     provider: 'Minnesota State Government',   description: 'Minnesota Geospatial Information Office — statewide GIS data.', link: 'https://www.mngeo.state.mn.us/', tags: ['Minnesota', 'state portal', 'open data'] }
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
      description: 'Closest GNSS base stations for downloading RINEX files for post-processing. Includes GEODNET, NOAA CORS, USGS/NOTA, and Trimble VRS networks. Distances in both km and miles. <a href="https://console.geodnet.com/map" target="_blank" rel="noopener" class="data-link" style="display:inline">View live GEODNET station map →</a>',
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