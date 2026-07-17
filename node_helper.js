const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const ADSBRadarNotifications = {
  CONFIG: "MMM_ADSB_RADAR_CONFIG",
  REQUEST: "MMM_ADSB_RADAR_REQUEST",
  UPDATE: "MMM_ADSB_RADAR_UPDATE",
  ERROR: "MMM_ADSB_RADAR_ERROR"
};

const DEFAULT_CENTER = {
  lat: 37.6213,
  lon: -122.379
};

module.exports = NodeHelper.create({
  requiresVersion: "2.1.0",

  start: function () {
    this.configs = {};
    this.fetchTimers = {};
    this.loading = {};
    this.aircraftDbCache = {};
    this.aircraftDbCacheOrder = [];
  },

  socketNotificationReceived: function (notification, payload) {
    if (!payload || !payload.instanceId) {
      return;
    }

    if (notification === ADSBRadarNotifications.CONFIG) {
      this.configs[payload.instanceId] = payload.config || {};
      this.scheduleRefresh(payload.instanceId, 250);
      return;
    }

    if (notification === ADSBRadarNotifications.REQUEST) {
      if (payload.config) {
        this.configs[payload.instanceId] = payload.config;
      }
      this.refreshAircraft(payload.instanceId);
    }
  },

  refreshAircraft: function (instanceId) {
    clearTimeout(this.fetchTimers[instanceId]);
    this.fetchTimers[instanceId] = null;

    if (this.loading[instanceId]) {
      return;
    }

    this.loading[instanceId] = true;
    this.loadAircraft(instanceId).catch((error) => {
      Log.error(`${this.name}: ${error.message}`);
      this.sendSocketNotification(ADSBRadarNotifications.ERROR, {
        instanceId,
        message: error.message
      });
    }).finally(() => {
      this.loading[instanceId] = false;
      this.scheduleRefresh(instanceId);
    });
  },

  scheduleRefresh: function (instanceId, delay) {
    clearTimeout(this.fetchTimers[instanceId]);
    this.fetchTimers[instanceId] = setTimeout(() => {
      this.refreshAircraft(instanceId);
    }, typeof delay === "number" ? delay : this.fetchIntervalMs(instanceId));
  },

  fetchIntervalMs: function (instanceId) {
    const config = this.configs[instanceId] || {};
    return Math.max(1000, Number(config.fetchInterval) || 15000);
  },

  loadAircraft: async function (instanceId) {
    const config = this.configs[instanceId] || {};
    const demo = this.shouldUseDemo(config);
    const center = this.resolveCenter(config, demo);

    if (!center) {
      throw new Error("Set centerLat and centerLon for the radar location.");
    }

    if (demo) {
      this.sendAircraftResult(instanceId, {
        feed: this.makeDemoFeed(config, center),
        status: "Demo traffic",
        source: "demo"
      }, config, center);
      return;
    }

    if (this.sourceMode(config) === "auto") {
      await this.loadAutoAircraft(instanceId, config, center);
      return;
    }

    const result = this.sourceMode(config) === "online" ?
      await this.loadOnlineFeed(config, center) :
      await this.loadReceiverFeed(config);

    this.sendAircraftResult(instanceId, result, config, center);
  },

  sendAircraftResult: function (instanceId, result, config, center, extraStats = {}) {
    const feed = result.feed || {};
    const feedAircraft = this.extractAircraft(feed);
    const normalized = this.normalizeAircraft(feedAircraft, config, center);
    const enriched = this.enrichAircraft(normalized, config);
    const aircraft = this.filterAircraft(enriched, config);

    this.sendSocketNotification(ADSBRadarNotifications.UPDATE, {
      instanceId,
      status: result.status,
      aircraft: aircraft.slice(0, config.maxAircraft || 28),
      stats: {
        source: result.source,
        provider: result.provider || null,
        totalFeedAircraft: feedAircraft.length,
        inRange: aircraft.length,
        messages: feed.messages || feed.total || null,
        feedTime: feed.now || feed.ctime || null,
        generatedAt: Date.now(),
        url: result.url || null,
        receiverError: extraStats.receiverError || null,
        onlineError: extraStats.onlineError || null
      }
    });
  },

  loadAutoAircraft: async function (instanceId, config, center) {
    let receiverResult = null;
    let receiverPayload = null;
    let receiverError = null;

    if (config.receiverUrl) {
      try {
        receiverResult = await this.loadReceiverFeed(config);
        receiverPayload = this.buildAircraftPayload(receiverResult, config, center);

        if (receiverPayload.aircraft.length > 0) {
          this.sendAircraftResult(instanceId, receiverResult, config, center);
          return;
        }
      } catch (error) {
        receiverError = error;
      }
    }

    try {
      const onlineResult = await this.loadOnlineFeed(config, center);
      this.sendAircraftResult(instanceId, {
        feed: onlineResult.feed,
        status: receiverResult ? "Online fallback" : onlineResult.status,
        source: onlineResult.source,
        provider: onlineResult.provider,
        url: onlineResult.url
      }, config, center, {
        receiverError: receiverError ? receiverError.message : null
      });
      return;
    } catch (onlineError) {
      if (receiverResult && receiverPayload) {
        this.sendAircraftResult(instanceId, receiverResult, config, center, {
          onlineError: onlineError.message
        });
        return;
      }

      throw receiverError || onlineError;
    }
  },

  buildAircraftPayload: function (result, config, center) {
    const feed = result.feed || {};
    const feedAircraft = this.extractAircraft(feed);
    const normalized = this.normalizeAircraft(feedAircraft, config, center);
    const enriched = this.enrichAircraft(normalized, config);
    const aircraft = this.filterAircraft(enriched, config);

    return {
      feedAircraft,
      aircraft
    };
  },

  loadReceiverFeed: async function (config) {
    if (!config.receiverUrl) {
      throw new Error("Set receiverUrl, use source: \"online\", or enable demoMode.");
    }

    return {
      feed: await this.fetchJson(config.receiverUrl, config.timeoutMs || 8000),
      status: "Live receiver",
      source: "receiver",
      url: config.receiverUrl
    };
  },

  loadOnlineFeed: async function (config, center) {
    const provider = this.onlineProvider(config);

    if (provider !== "airplanesLive") {
      throw new Error(`Unsupported onlineProvider: ${config.onlineProvider}`);
    }

    const url = this.airplanesLiveUrl(config, center);

    return {
      feed: await this.fetchJson(url, config.timeoutMs || 8000),
      status: "Online Airplanes.live",
      source: "online",
      provider,
      url
    };
  },

  shouldUseDemo: function (config) {
    const mode = this.sourceMode(config);

    if (mode === "demo") {
      return config.demoMode !== false;
    }

    if (config.demoMode === true) {
      return true;
    }

    if (config.demoMode === false) {
      return false;
    }

    return !config.receiverUrl && mode === "receiver";
  },

  sourceMode: function (config) {
    const source = String(config.source || config.dataSource || "receiver").trim().toLowerCase();

    if (["online", "internet", "airplaneslive", "airplanes.live"].includes(source)) {
      return "online";
    }

    if (["auto", "fallback", "hybrid"].includes(source)) {
      return "auto";
    }

    if (source === "demo") {
      return "demo";
    }

    return "receiver";
  },

  onlineProvider: function (config) {
    const provider = String(config.onlineProvider || "airplanesLive").trim().toLowerCase();

    if (["airplaneslive", "airplanes.live", "airplanes_live"].includes(provider)) {
      return "airplanesLive";
    }

    return provider;
  },

  airplanesLiveUrl: function (config, center) {
    const radius = Math.min(250, Math.max(1, Math.ceil(Number(config.onlineRangeNm) || Number(config.rangeNm) || 30)));
    const template = config.airplanesLiveUrl || config.onlineUrl || "https://api.airplanes.live/v2/point/{lat}/{lon}/{radius}";
    const replacements = {
      lat: center.lat.toFixed(5),
      lon: center.lon.toFixed(5),
      radius,
      range: radius
    };

    return String(template).replace(/\{(lat|lon|radius|range)\}/g, (match, key) => encodeURIComponent(replacements[key]));
  },

  resolveCenter: function (config, demo) {
    const lat = this.numberOrNull(config.centerLat);
    const lon = this.numberOrNull(config.centerLon);

    if (lat !== null && lon !== null) {
      return { lat, lon };
    }

    if (demo) {
      return DEFAULT_CENTER;
    }

    return null;
  },

  extractAircraft: function (feed) {
    if (!feed) {
      return [];
    }

    if (Array.isArray(feed.aircraft)) {
      return feed.aircraft;
    }

    if (Array.isArray(feed.ac)) {
      return feed.ac;
    }

    if (Array.isArray(feed)) {
      return feed;
    }

    const flights = feed.flights && typeof feed.flights === "object" ? feed.flights : feed;

    if (!flights || Array.isArray(flights) || typeof flights !== "object") {
      return [];
    }

    return Object.entries(flights)
      .map(([key, value]) => this.normalizeFr24Entry(key, value))
      .filter(Boolean);
  },

  normalizeFr24Entry: function (key, value) {
    if (Array.isArray(value)) {
      return this.normalizeFr24Array(key, value);
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    const lat = this.firstNumber(value.lat, value.latitude);
    const lon = this.firstNumber(value.lon, value.long, value.lng, value.longitude);

    if (lat === null || lon === null) {
      return null;
    }

    return {
      hex: this.cleanHex(value.hex || value.id || key),
      flight: this.firstString(value.flight, value.callsign, value.call, value.name),
      aircraftType: this.firstString(value.aircraftType, value.aircraft_type, value.type, value.equipment, value.model, value.icaoType, value.ac_type),
      registration: this.firstString(value.registration, value.reg, value.tail),
      lat,
      lon,
      alt_baro: this.firstNumber(value.alt_baro, value.alt, value.altitude),
      alt_geom: this.numberOrNull(value.alt_geom),
      gs: this.firstNumber(value.gs, value.speed, value.spd),
      track: this.firstNumber(value.track, value.heading, value.bearing),
      squawk: value.squawk || value.sqw || "",
      seen: this.firstNumber(value.seen, value.seen_pos, this.seenFromTimestamp(value.timestamp || value.time || value.updated))
    };
  },

  normalizeFr24Array: function (key, value) {
    const lat = this.numberOrNull(value[1]);
    const lon = this.numberOrNull(value[2]);

    if (lat === null || lon === null) {
      return null;
    }

    return {
      hex: this.cleanHex(value[0] || key),
      flight: this.firstString(value[16], value[13], value[9]),
      aircraftType: this.firstString(value[8]),
      registration: this.firstString(value[9]),
      lat,
      lon,
      track: this.numberOrNull(value[3]),
      alt_baro: this.numberOrNull(value[4]),
      gs: this.numberOrNull(value[5]),
      squawk: value[6] || "",
      seen: this.seenFromTimestamp(value[10]) || 0
    };
  },

  normalizeAircraft: function (aircraft, config, center) {
    return aircraft
      .map((item) => {
        const lat = this.numberOrNull(item.lat);
        const lon = this.numberOrNull(item.lon);

        if (lat === null || lon === null) {
          return null;
        }

        const distanceNm = this.distanceNm(center.lat, center.lon, lat, lon);
        const seen = this.firstNumber(item.seen_pos, item.seen) || 0;
        const altitudeFt = this.altitude(item);
        const track = this.firstNumber(item.track, item.true_heading, item.nav_heading, item.mag_heading);

        return {
          hex: this.cleanHex(item.hex || item.icao24 || item.icao || item.addr || ""),
          flight: this.firstString(item.flight, item.callsign),
          aircraftType: this.firstString(item.aircraftType, item.aircraft_type, item.type, item.t, item.equipment, item.model),
          registration: this.firstString(item.registration, item.reg, item.r),
          lat,
          lon,
          altitudeFt,
          speedKt: this.firstNumber(item.gs, item.tas, item.ias),
          track,
          bearing: this.bearing(center.lat, center.lon, lat, lon),
          distanceNm,
          seen,
          isStale: seen > Math.min(config.maxSeenSeconds || 45, 20),
          squawk: item.squawk || "",
          emergency: this.isEmergency(item)
        };
      })
      .filter(Boolean);
  },

  enrichAircraft: function (aircraft, config) {
    if (!this.aircraftDbEnabled(config)) {
      return aircraft;
    }

    return aircraft.map((item) => {
      if (!item.hex || (item.aircraftType && item.registration)) {
        return item;
      }

      const lookup = this.aircraftDbLookup(item.hex, config);

      if (!lookup) {
        return item;
      }

      return Object.assign({}, item, {
        aircraftType: item.aircraftType || lookup.aircraftType || "",
        registration: item.registration || lookup.registration || "",
        aircraftModel: item.aircraftModel || lookup.model || "",
        aircraftOperator: item.aircraftOperator || lookup.operator || ""
      });
    });
  },

  aircraftDbEnabled: function (config) {
    return config.aircraftDbEnabled !== false;
  },

  aircraftDbLookup: function (hex, config) {
    const cleanHex = this.cleanHex(hex);
    const prefixLength = this.aircraftDbChunkLength(config);

    if (!cleanHex || cleanHex.length < prefixLength) {
      return null;
    }

    const prefix = cleanHex.slice(0, prefixLength);
    const chunk = this.loadAircraftDbChunk(prefix, config);
    const record = chunk && chunk[cleanHex];

    return this.decodeAircraftDbRecord(record);
  },

  loadAircraftDbChunk: function (prefix, config) {
    if (Object.prototype.hasOwnProperty.call(this.aircraftDbCache, prefix)) {
      return this.aircraftDbCache[prefix];
    }

    const filePath = path.join(this.aircraftDbDirectory(config), `${prefix}.json`);
    let chunk = null;

    try {
      if (fs.existsSync(filePath)) {
        chunk = JSON.parse(fs.readFileSync(filePath, "utf8"));
      }
    } catch (error) {
      Log.warn(`${this.name}: Could not load aircraft DB chunk ${prefix}: ${error.message}`);
      chunk = null;
    }

    this.rememberAircraftDbChunk(prefix, chunk, config);
    return chunk;
  },

  rememberAircraftDbChunk: function (prefix, chunk, config) {
    this.aircraftDbCache[prefix] = chunk;
    this.aircraftDbCacheOrder = this.aircraftDbCacheOrder.filter((item) => item !== prefix);
    this.aircraftDbCacheOrder.push(prefix);

    const maxCachedChunks = Math.max(1, Number(config.aircraftDbMaxCachedChunks) || 16);
    while (this.aircraftDbCacheOrder.length > maxCachedChunks) {
      const oldest = this.aircraftDbCacheOrder.shift();
      delete this.aircraftDbCache[oldest];
    }
  },

  aircraftDbDirectory: function (config) {
    const configuredPath = config.aircraftDbPath || "aircraft-db";
    return path.isAbsolute(configuredPath) ? configuredPath : path.join(__dirname, configuredPath);
  },

  aircraftDbChunkLength: function (config) {
    return Math.max(1, Math.min(6, Number(config.aircraftDbChunkLength) || 2));
  },

  decodeAircraftDbRecord: function (record) {
    if (!record) {
      return null;
    }

    if (Array.isArray(record)) {
      return {
        aircraftType: this.firstString(record[0]),
        registration: this.firstString(record[1]),
        model: this.firstString(record[2]),
        operator: this.firstString(record[3])
      };
    }

    if (typeof record === "object") {
      return {
        aircraftType: this.firstString(record.aircraftType, record.typecode, record.type, record.t),
        registration: this.firstString(record.registration, record.reg, record.r),
        model: this.firstString(record.model),
        operator: this.firstString(record.operator, record.owner)
      };
    }

    return null;
  },

  filterAircraft: function (aircraft, config) {
    const rangeNm = Number(config.rangeNm) || 30;
    const maxSeenSeconds = Number(config.maxSeenSeconds) || 45;
    const minAltitudeFt = this.numberOrNull(config.minAltitudeFt);
    const maxAltitudeFt = this.numberOrNull(config.maxAltitudeFt);

    return aircraft
      .filter((item) => item.distanceNm <= rangeNm)
      .filter((item) => item.seen <= maxSeenSeconds)
      .filter((item) => minAltitudeFt === null || item.altitudeFt === null || item.altitudeFt >= minAltitudeFt)
      .filter((item) => maxAltitudeFt === null || item.altitudeFt === null || item.altitudeFt <= maxAltitudeFt)
      .sort((a, b) => {
        if (a.emergency && !b.emergency) {
          return -1;
        }
        if (!a.emergency && b.emergency) {
          return 1;
        }
        return a.distanceNm - b.distanceNm;
      });
  },

  fetchJson: function (url, timeoutMs, redirects = 0) {
    return new Promise((resolve, reject) => {
      let parsedUrl;

      try {
        parsedUrl = new URL(url);
      } catch (error) {
        reject(new Error(`Invalid receiverUrl: ${url}`));
        return;
      }

      const transport = parsedUrl.protocol === "https:" ? https : http;
      const request = transport.get(parsedUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 3) {
            reject(new Error("Too many redirects while loading ADS-B feed."));
            return;
          }
          const nextUrl = new URL(response.headers.location, parsedUrl).toString();
          this.fetchJson(nextUrl, timeoutMs, redirects + 1).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`ADS-B feed returned HTTP ${response.statusCode}.`));
          return;
        }

        response.setEncoding("utf8");
        let raw = "";

        response.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 5 * 1024 * 1024) {
            request.destroy(new Error("ADS-B feed is larger than expected."));
          }
        });

        response.on("end", () => {
          try {
            resolve(this.parseFeed(raw));
          } catch (error) {
            reject(new Error("ADS-B feed did not return valid JSON."));
          }
        });
      });

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error("Timed out while loading ADS-B feed."));
      });

      request.on("error", reject);
    });
  },

  parseFeed: function (raw) {
    const trimmed = String(raw || "").trim();
    const jsonpMatch = trimmed.match(/^[A-Za-z_$][\w$]*\(([\s\S]*)\);?$/);
    const json = jsonpMatch ? jsonpMatch[1] : trimmed;
    return JSON.parse(json);
  },

  makeDemoFeed: function (config, center) {
    const rangeNm = Number(config.rangeNm) || 30;
    const now = Date.now() / 1000;
    const callsigns = ["AAL214", "DAL94", "UAL530", "SWA1827", "JBU616", "FDX73", "UPS118", "N42MM", "ASA808", "BAW21"];
    const aircraft = callsigns.map((flight, index) => {
      const orbit = (now / (24 + index * 3) + index * 37) % 360;
      const distance = rangeNm * (0.16 + (index % 7) * 0.1);
      const point = this.destinationPoint(center.lat, center.lon, orbit, distance);
      const track = (orbit + 80 + index * 11) % 360;

      return {
        hex: `D${(10000 + index * 137).toString(16).toUpperCase()}`,
        flight,
        lat: point.lat,
        lon: point.lon,
        alt_baro: 2500 + index * 3100,
        aircraftType: ["B738", "A321", "B739", "B737", "A320", "B763", "B752", "C172", "E75L", "B789"][index],
        gs: 135 + index * 29,
        track,
        seen: index % 4,
        seen_pos: index % 5
      };
    });

    return {
      now,
      messages: Math.round(now) % 100000,
      aircraft
    };
  },

  altitude: function (aircraft) {
    if (aircraft.alt_baro === "ground") {
      return 0;
    }

    return this.firstNumber(aircraft.alt_baro, aircraft.alt_geom);
  },

  isEmergency: function (aircraft) {
    const emergency = typeof aircraft.emergency === "string" ? aircraft.emergency.toLowerCase() : "";
    return emergency && emergency !== "none" || ["7500", "7600", "7700"].includes(String(aircraft.squawk || ""));
  },

  cleanHex: function (value) {
    return String(value || "").replace(/^x/i, "").trim().toUpperCase();
  },

  firstString: function (...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  },

  firstNumber: function (...values) {
    for (const value of values) {
      const number = this.numberOrNull(value);
      if (number !== null) {
        return number;
      }
    }
    return null;
  },

  numberOrNull: function (value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  },

  seenFromTimestamp: function (value) {
    const timestamp = this.numberOrNull(value);

    if (timestamp === null) {
      return null;
    }

    const seconds = timestamp > 10000000000 ? timestamp / 1000 : timestamp;
    return Math.max(0, Date.now() / 1000 - seconds);
  },

  distanceNm: function (lat1, lon1, lat2, lon2) {
    const earthRadiusNm = 3440.065;
    const phi1 = this.toRadians(lat1);
    const phi2 = this.toRadians(lat2);
    const deltaPhi = this.toRadians(lat2 - lat1);
    const deltaLambda = this.toRadians(lon2 - lon1);
    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) *
      Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusNm * c;
  },

  bearing: function (lat1, lon1, lat2, lon2) {
    const phi1 = this.toRadians(lat1);
    const phi2 = this.toRadians(lat2);
    const deltaLambda = this.toRadians(lon2 - lon1);
    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
    return (this.toDegrees(Math.atan2(y, x)) + 360) % 360;
  },

  destinationPoint: function (lat, lon, bearing, distanceNm) {
    const earthRadiusNm = 3440.065;
    const angularDistance = distanceNm / earthRadiusNm;
    const theta = this.toRadians(bearing);
    const phi1 = this.toRadians(lat);
    const lambda1 = this.toRadians(lon);
    const phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(angularDistance) +
      Math.cos(phi1) * Math.sin(angularDistance) * Math.cos(theta)
    );
    const lambda2 = lambda1 + Math.atan2(
      Math.sin(theta) * Math.sin(angularDistance) * Math.cos(phi1),
      Math.cos(angularDistance) - Math.sin(phi1) * Math.sin(phi2)
    );

    return {
      lat: this.toDegrees(phi2),
      lon: ((this.toDegrees(lambda2) + 540) % 360) - 180
    };
  },

  toRadians: function (degrees) {
    return (degrees * Math.PI) / 180;
  },

  toDegrees: function (radians) {
    return (radians * 180) / Math.PI;
  }
});
