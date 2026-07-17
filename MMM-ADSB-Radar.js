/* global Module, Log */

const ADSBRadarNotifications = {
  CONFIG: "MMM_ADSB_RADAR_CONFIG",
  REQUEST: "MMM_ADSB_RADAR_REQUEST",
  UPDATE: "MMM_ADSB_RADAR_UPDATE",
  ERROR: "MMM_ADSB_RADAR_ERROR"
};

Module.register("MMM-ADSB-Radar", {
  requiresVersion: "2.1.0",

  defaults: {
    receiverUrl: "",
    source: "receiver",
    onlineProvider: "airplanesLive",
    onlineUrl: "",
    airplanesLiveUrl: "",
    onlineRangeNm: null,
    aircraftDbEnabled: true,
    aircraftDbPath: "aircraft-db",
    aircraftDbChunkLength: 2,
    aircraftDbMaxCachedChunks: 16,
    centerLat: 37.6213,
    centerLon: -122.379,
    rangeNm: 35,
    fetchInterval: 15000,
    maxSeenSeconds: 45,
    maxAircraft: 28,
    persistTracks: true,
    trackPersistenceMs: 45000,
    trackPersistenceMaxMisses: 2,
    animateAircraft: true,
    aircraftAnimationDurationMs: null,
    aircraftAnimationMaxDistanceNm: 3,
    minAltitudeFt: null,
    maxAltitudeFt: null,
    mode: "hybrid",
    title: "ADS-B Radar",
    radarSize: 360,
    animationSpeed: 0,
    showLabels: true,
    showStats: true,
    showList: true,
    listWidth: 220,
    listMaxHeight: null,
    showRangeLabels: true,
    rangeLabelCount: 4,
    showTrails: true,
    trailMaxPoints: 4,
    trailMaxAgeMs: 90000,
    showLeaderLines: true,
    showLabelConnectors: true,
    showHeadingVectors: true,
    headingVectorMinPx: 10,
    headingVectorMaxPx: 46,
    headingVectorKtPerPixel: 12,
    showAirports: true,
    airports: [
      { code: "SFO", name: "San Francisco Intl", lat: 37.6213, lon: -122.379 },
      { code: "OAK", name: "Oakland Intl", lat: 37.7213, lon: -122.2207 },
      { code: "SJC", name: "San Jose Intl", lat: 37.3639, lon: -121.9289 }
    ],
    demoMode: "auto",
    units: "imperial",
    colors: {
      scope: "#061408",
      ring: "rgba(134, 255, 118, 0.26)",
      sweep: "rgba(96, 255, 96, 0.14)",
      aircraft: "#7dff72",
      aircraftStale: "#ffcf70",
      airport: "#a5aaa8",
      text: "#ddffd8",
      muted: "#96bd91",
      accent: "#cfff7a"
    }
  },

  start: function () {
    this.instanceId = this.identifier || `${this.name}-${Date.now()}`;
    this.aircraft = [];
    this.stats = {};
    this.status = "Starting radar";
    this.error = null;
    this.lastUpdated = null;
    this.fetchTimer = null;
    this.trails = {};
    this.trackedAircraft = {};

    this.sendConfig();
    this.scheduleFetch(100);
  },

  getStyles: function () {
    return [this.file("MMM-ADSB-Radar.css")];
  },

  getHeader: function () {
    return this.config.title || this.data.header;
  },

  suspend: function () {
    clearTimeout(this.fetchTimer);
    this.fetchTimer = null;
  },

  resume: function () {
    this.sendConfig();
    this.scheduleFetch(100);
  },

  sendConfig: function () {
    this.sendSocketNotification(ADSBRadarNotifications.CONFIG, {
      instanceId: this.instanceId,
      config: this.config
    });
  },

  scheduleFetch: function (delay) {
    clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => {
      this.sendSocketNotification(ADSBRadarNotifications.REQUEST, {
        instanceId: this.instanceId,
        config: this.config
      });
      this.scheduleFetch();
    }, typeof delay === "number" ? delay : this.fetchIntervalMs());
  },

  socketNotificationReceived: function (notification, payload) {
    if (!payload || payload.instanceId !== this.instanceId) {
      return;
    }

    if (notification === ADSBRadarNotifications.UPDATE) {
      this.error = null;
      this.status = payload.status || "Radar updated";
      this.stats = payload.stats || {};
      this.lastUpdated = new Date(Date.now());
      this.aircraft = this.mergeTrackedAircraft(this.prepareAircraft(payload.aircraft || []));
      this.updateTrails(this.aircraft);
      this.updateDom(this.domAnimationSpeed());
      return;
    }

    if (notification === ADSBRadarNotifications.ERROR) {
      this.error = payload.message || "Unable to load ADS-B feed";
      this.status = "Feed unavailable";
      this.stats = payload.stats || {};
      this.updateDom(this.domAnimationSpeed());
    }
  },

  domAnimationSpeed: function () {
    const speed = Number(this.config.animationSpeed);
    return Number.isFinite(speed) ? speed : 0;
  },

  prepareAircraft: function (aircraft) {
    return aircraft
      .filter((item) => typeof item.distanceNm === "number" && item.distanceNm <= this.config.rangeNm)
      .sort((a, b) => a.distanceNm - b.distanceNm)
      .slice(0, this.config.maxAircraft);
  },

  mergeTrackedAircraft: function (liveAircraft) {
    if (!this.config.persistTracks) {
      this.trackedAircraft = {};
      return liveAircraft;
    }

    const now = Date.now();
    const activeKeys = {};
    const retainedAircraft = [];
    const maxAgeMs = Math.max(0, Number(this.config.trackPersistenceMs) || 0);
    const maxMisses = Math.max(0, Number(this.config.trackPersistenceMaxMisses) || 0);

    liveAircraft.forEach((plane) => {
      const key = this.trackKey(plane);

      if (!key) {
        return;
      }

      activeKeys[key] = true;
      this.trackedAircraft[key] = {
        aircraft: Object.assign({}, plane, {
          isCoasting: false,
          coastingAgeMs: 0,
          missedPolls: 0
        }),
        lastSeenAt: now,
        missedPolls: 0
      };
    });

    Object.keys(this.trackedAircraft).forEach((key) => {
      const track = this.trackedAircraft[key];

      if (activeKeys[key]) {
        return;
      }

      track.missedPolls = (track.missedPolls || 0) + 1;

      const ageMs = now - track.lastSeenAt;
      if (ageMs > maxAgeMs || track.missedPolls > maxMisses) {
        delete this.trackedAircraft[key];
        return;
      }

      retainedAircraft.push(Object.assign({}, track.aircraft, {
        isCoasting: true,
        coastingAgeMs: ageMs,
        missedPolls: track.missedPolls,
        seen: Math.max(track.aircraft.seen || 0, ageMs / 1000),
        isStale: track.aircraft.isStale || ageMs > this.fetchIntervalMs()
      }));
    });

    return liveAircraft
      .concat(retainedAircraft)
      .filter((item) => typeof item.distanceNm === "number" && item.distanceNm <= this.config.rangeNm)
      .sort((a, b) => {
        if (a.isCoasting && !b.isCoasting) {
          return 1;
        }

        if (!a.isCoasting && b.isCoasting) {
          return -1;
        }

        return a.distanceNm - b.distanceNm;
      })
      .slice(0, this.config.maxAircraft);
  },

  trackKey: function (plane) {
    return String(plane.hex || plane.flight || plane.registration || "").trim().toUpperCase();
  },

  fetchIntervalMs: function () {
    return Math.max(0, Number(this.config.fetchInterval) || this.defaults.fetchInterval);
  },

  updateTrails: function (aircraft) {
    if (!this.config.showTrails) {
      this.trails = {};
      return;
    }

    const activeKeys = {};
    const now = Date.now();

    aircraft.forEach((plane) => {
      const key = this.trackKey(plane);
      if (!key) {
        return;
      }

      activeKeys[key] = true;
      if (plane.isCoasting) {
        return;
      }

      if (!this.trails[key]) {
        this.trails[key] = [];
      }

      this.trails[key].push({
        bearing: plane.bearing,
        distanceNm: plane.distanceNm,
        timestamp: now
      });

      this.trails[key] = this.trails[key]
        .filter((point) => now - point.timestamp < this.config.trailMaxAgeMs)
        .slice(-this.config.trailMaxPoints);
    });

    Object.keys(this.trails).forEach((key) => {
      this.trails[key] = this.trails[key].filter((point) => now - point.timestamp < this.config.trailMaxAgeMs);

      if (!activeKeys[key]) {
        this.trails[key] = this.trails[key].filter((point) => now - point.timestamp < this.config.trailMaxAgeMs / 2);
      }

      if (this.trails[key].length === 0) {
        delete this.trails[key];
      }
    });
  },

  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.className = `mmm-adsb-radar mmm-adsb-radar--${this.config.mode}`;
    this.applyTheme(wrapper);

    wrapper.appendChild(this.buildTopBar());

    if (this.error) {
      wrapper.appendChild(this.buildMessage(this.error));
    }

    const body = document.createElement("div");
    body.className = "adsb-body";

    if (this.config.mode !== "list") {
      body.appendChild(this.buildRadar());
    }

    if (this.config.mode !== "radar" && this.config.showList) {
      body.appendChild(this.buildAircraftList());
    }

    if (body.childNodes.length > 0) {
      wrapper.appendChild(body);
    }

    return wrapper;
  },

  applyTheme: function (element) {
    const colors = this.config.colors || {};
    element.style.setProperty("--adsb-scope", colors.scope || this.defaults.colors.scope);
    element.style.setProperty("--adsb-ring", colors.ring || this.defaults.colors.ring);
    element.style.setProperty("--adsb-sweep", colors.sweep || this.defaults.colors.sweep);
    element.style.setProperty("--adsb-plane", colors.aircraft || this.defaults.colors.aircraft);
    element.style.setProperty("--adsb-plane-stale", colors.aircraftStale || this.defaults.colors.aircraftStale);
    element.style.setProperty("--adsb-airport", colors.airport || this.defaults.colors.airport);
    element.style.setProperty("--adsb-text", colors.text || this.defaults.colors.text);
    element.style.setProperty("--adsb-muted", colors.muted || this.defaults.colors.muted);
    element.style.setProperty("--adsb-accent", colors.accent || this.defaults.colors.accent);
    element.style.setProperty("--adsb-size", this.cssLength(this.config.radarSize, this.defaults.radarSize));
    element.style.setProperty("--adsb-list-width", this.cssLength(this.config.listWidth, this.defaults.listWidth));
    element.style.setProperty("--adsb-list-max-height", this.listMaxHeight());
  },

  buildTopBar: function () {
    const bar = document.createElement("div");
    bar.className = "adsb-topbar";

    const status = document.createElement("div");
    status.className = "adsb-status";
    status.textContent = this.statusText();
    bar.appendChild(status);

    if (this.config.showStats) {
      const stats = document.createElement("div");
      stats.className = "adsb-stats";
      stats.appendChild(this.statPill(`${this.aircraft.length}`, "aircraft"));
      stats.appendChild(this.statPill(`${this.config.rangeNm} nm`, "range"));

      if (this.lastUpdated) {
        stats.appendChild(this.statPill(this.formatTime(this.lastUpdated), "updated"));
      }

      bar.appendChild(stats);
    }

    return bar;
  },

  buildMessage: function (message) {
    const element = document.createElement("div");
    element.className = "adsb-message";
    element.textContent = message;
    return element;
  },

  buildRadar: function () {
    const scope = document.createElement("div");
    scope.className = "adsb-scope";
    scope.setAttribute("aria-label", "Nearby aircraft radar scope");

    const sweep = document.createElement("div");
    sweep.className = "adsb-sweep";
    scope.appendChild(sweep);

    this.buildRangeRings().forEach((ring) => {
      scope.appendChild(ring);
    });

    const ownship = document.createElement("div");
    ownship.className = "adsb-ownship";
    scope.appendChild(ownship);

    this.buildRangeLabels().forEach((label) => {
      scope.appendChild(label);
    });

    this.prepareAirports().forEach((airport) => {
      scope.appendChild(this.buildAirportMarker(airport));
    });

    Object.keys(this.trails).forEach((key) => {
      const points = this.trails[key].slice(0, -1);

      points.forEach((point, index) => {
        const trail = document.createElement("div");
        const position = this.pointOnScope(point);
        trail.className = "adsb-trail";
        trail.style.left = `${position.x}%`;
        trail.style.top = `${position.y}%`;
        trail.style.opacity = `${0.1 + (index + 1) / (points.length + 1) * 0.24}`;
        scope.appendChild(trail);
      });
    });

    this.aircraft.forEach((plane) => {
      const marker = this.buildAircraftMarker(plane);
      if (marker) {
        scope.appendChild(marker);
      }
    });

    if (this.aircraft.length === 0 && !this.error) {
      const empty = document.createElement("div");
      empty.className = "adsb-empty";
      empty.textContent = "No aircraft in range";
      scope.appendChild(empty);
    }

    return scope;
  },

  buildRangeRings: function () {
    if (!this.config.showRangeLabels) {
      return [];
    }

    const count = Math.max(1, Number(this.config.rangeLabelCount) || 4);

    return Array.from({ length: count }, (_, index) => {
      const ringNumber = index + 1;
      const radiusPercent = this.rangeRingRadiusPercent(ringNumber, count);
      const ring = document.createElement("div");
      ring.className = "adsb-range-ring";
      ring.style.width = `${radiusPercent * 2}%`;
      ring.style.height = `${radiusPercent * 2}%`;
      return ring;
    });
  },

  buildRangeLabels: function () {
    if (!this.config.showRangeLabels) {
      return [];
    }

    const rangeNm = Number(this.config.rangeNm);
    const count = Math.max(1, Number(this.config.rangeLabelCount) || 4);

    if (!Number.isFinite(rangeNm) || rangeNm <= 0) {
      return [];
    }

    return Array.from({ length: count }, (_, index) => {
      const ringNumber = index + 1;
      const distance = Math.round(rangeNm * ringNumber / count);
      const radiusPercent = this.rangeRingRadiusPercent(ringNumber, count);
      const label = document.createElement("div");
      label.className = "adsb-range-label";
      label.style.top = `${50 - radiusPercent}%`;
      label.textContent = `${distance}`;
      label.title = `${distance} nm`;
      return label;
    });
  },

  rangeRingRadiusPercent: function (ringNumber, count) {
    return 47 * ringNumber / count;
  },

  prepareAirports: function () {
    if (!this.config.showAirports || !Array.isArray(this.config.airports)) {
      return [];
    }

    const centerLat = Number(this.config.centerLat);
    const centerLon = Number(this.config.centerLon);

    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
      return [];
    }

    return this.config.airports
      .map((airport) => {
        const lat = Number(airport.lat);
        const lon = Number(airport.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return null;
        }

        const distanceNm = this.distanceNm(centerLat, centerLon, lat, lon);

        return {
          code: airport.code || airport.ident || airport.name || "",
          name: airport.name || airport.code || airport.ident || "",
          lat,
          lon,
          distanceNm,
          bearing: this.bearing(centerLat, centerLon, lat, lon)
        };
      })
      .filter((airport) => airport && airport.distanceNm <= this.config.rangeNm);
  },

  buildAirportMarker: function (airport) {
    const position = this.pointOnScope(airport);
    const marker = document.createElement("div");
    marker.className = "adsb-airport";
    marker.classList.add(position.x > 70 ? "adsb-airport--label-left" : "adsb-airport--label-right");
    marker.style.left = `${position.x}%`;
    marker.style.top = `${position.y}%`;
    marker.title = [
      airport.code,
      airport.name,
      this.formatDistance(airport.distanceNm)
    ]
      .filter(Boolean)
      .join(" | ");

    const symbol = document.createElement("div");
    symbol.className = "adsb-airport-symbol";
    marker.appendChild(symbol);

    const label = document.createElement("div");
    label.className = "adsb-airport-label";
    label.textContent = airport.code || airport.name;
    marker.appendChild(label);

    return marker;
  },

  buildAircraftMarker: function (plane) {
    const position = this.pointOnScope(plane);
    if (!position) {
      return null;
    }

    const marker = document.createElement("div");
    marker.className = "adsb-aircraft";
    marker.classList.add(position.x > 68 ? "adsb-aircraft--label-left" : "adsb-aircraft--label-right");
    marker.classList.add(position.y < 24 ? "adsb-aircraft--label-low" : "adsb-aircraft--label-high");
    if (plane.isStale) {
      marker.classList.add("adsb-aircraft--stale");
    }
    if (plane.isCoasting) {
      marker.classList.add("adsb-aircraft--coasting");
    }
    if (plane.emergency) {
      marker.classList.add("adsb-aircraft--emergency");
    }

    const heading = this.aircraftHeading(plane) || 0;
    const animatedPosition = this.aircraftAnimationPosition(plane, position);
    marker.style.left = `${animatedPosition.start.x}%`;
    marker.style.top = `${animatedPosition.start.y}%`;
    marker.style.transform = "translate(-50%, -50%)";
    marker.title = this.aircraftTitle(plane);

    if (animatedPosition.end) {
      marker.classList.add("adsb-aircraft--drifting");
      marker.style.setProperty("--adsb-x-start", `${animatedPosition.start.x}%`);
      marker.style.setProperty("--adsb-y-start", `${animatedPosition.start.y}%`);
      marker.style.setProperty("--adsb-x-end", `${animatedPosition.end.x}%`);
      marker.style.setProperty("--adsb-y-end", `${animatedPosition.end.y}%`);
      marker.style.setProperty("--adsb-drift-duration", `${this.aircraftAnimationDurationMs()}ms`);
    }

    if (this.config.showLeaderLines && this.config.showHeadingVectors) {
      const vector = document.createElement("div");
      vector.className = "adsb-heading-vector";
      vector.style.width = `${this.headingVectorLength(plane)}px`;
      vector.style.transform = `rotate(${heading - 90}deg)`;
      marker.appendChild(vector);
    }

    const icon = document.createElement("div");
    icon.className = "adsb-aircraft-icon";
    marker.appendChild(icon);

    if (this.config.showLabels) {
      if (this.config.showLabelConnectors) {
        const connector = document.createElement("div");
        connector.className = "adsb-label-connector";
        marker.appendChild(connector);
      }

      const label = document.createElement("div");
      label.className = "adsb-aircraft-label";
      this.aircraftLabelLines(plane).forEach((line, index) => {
        const labelLine = document.createElement("div");
        labelLine.className = index === 0 ? "adsb-aircraft-label-primary" : "adsb-aircraft-label-secondary";
        labelLine.textContent = line;
        label.appendChild(labelLine);
      });
      marker.appendChild(label);
    }

    return marker;
  },

  buildAircraftList: function () {
    const list = document.createElement("div");
    list.className = "adsb-list";

    if (this.aircraft.length === 0) {
      list.appendChild(this.buildAircraftListEmptyRow(this.error ? "Waiting for feed" : "No nearby aircraft"));
      return list;
    }

    this.aircraft.forEach((plane) => {
      list.appendChild(this.buildAircraftListRow(plane));
    });

    return list;
  },

  buildAircraftListRow: function (plane) {
    const row = document.createElement("div");
    row.className = "adsb-row";
    if (plane.emergency) {
      row.classList.add("adsb-row--emergency");
    }
    if (plane.isCoasting) {
      row.classList.add("adsb-row--coasting");
    }

    const callsign = document.createElement("div");
    callsign.className = "adsb-row-callsign";
    callsign.textContent = plane.flight || plane.hex || "Unknown";
    row.appendChild(callsign);

    const type = document.createElement("div");
    type.className = "adsb-row-type";
    type.textContent = plane.aircraftType || "--";
    row.appendChild(type);

    const details = document.createElement("div");
    details.className = "adsb-row-details";
    details.textContent = [
      this.formatDistance(plane.distanceNm),
      this.formatAltitude(plane.altitudeFt),
      this.formatSpeed(plane.speedKt)
    ]
      .filter(Boolean)
      .join(" | ");
    row.appendChild(details);

    return row;
  },

  buildAircraftListEmptyRow: function (message) {
    const row = document.createElement("div");
    row.className = "adsb-row adsb-row--empty";
    row.textContent = message;
    return row;
  },

  listMaxHeight: function () {
    if (this.config.listMaxHeight === null || this.config.listMaxHeight === undefined || this.config.listMaxHeight === "") {
      return `min(var(--adsb-size), 92vw)`;
    }

    if (typeof this.config.listMaxHeight === "number") {
      return `${this.config.listMaxHeight}px`;
    }

    return String(this.config.listMaxHeight);
  },

  cssLength: function (value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return `${value}px`;
    }

    const text = String(value || "").trim();
    if (!text) {
      return `${fallback}px`;
    }

    return /^\d+(\.\d+)?$/.test(text) ? `${text}px` : text;
  },

  headingVectorLength: function (plane) {
    const min = Number(this.config.headingVectorMinPx) || 10;
    const max = Number(this.config.headingVectorMaxPx) || 46;
    const ktPerPixel = Number(this.config.headingVectorKtPerPixel) || 12;
    const speed = typeof plane.speedKt === "number" ? plane.speedKt : 0;
    return Math.max(min, Math.min(max, speed / ktPerPixel));
  },

  pointOnScope: function (plane) {
    if (typeof plane.bearing !== "number" || typeof plane.distanceNm !== "number") {
      return null;
    }

    const radius = Math.min(plane.distanceNm / this.config.rangeNm, 1) * 47;
    const radians = (plane.bearing * Math.PI) / 180;

    return {
      x: 50 + Math.sin(radians) * radius,
      y: 50 - Math.cos(radians) * radius
    };
  },

  aircraftAnimationPosition: function (plane, position) {
    if (!this.config.animateAircraft || !position) {
      return { start: position, end: null };
    }

    const durationMs = this.aircraftAnimationDurationMs();
    const startAgeMs = plane.isCoasting ? Math.max(0, Number(plane.coastingAgeMs) || 0) : 0;
    const start = startAgeMs > 0 ? this.projectPosition(plane, position, startAgeMs) : position;
    const end = this.projectPosition(plane, start, durationMs);

    if (!end || this.positionsAreSame(start, end)) {
      return { start, end: null };
    }

    return { start, end };
  },

  aircraftAnimationDurationMs: function () {
    const configuredDuration = this.config.aircraftAnimationDurationMs;
    if (configuredDuration === null || configuredDuration === undefined || configuredDuration === "") {
      return this.fetchIntervalMs();
    }

    const duration = Number(this.config.aircraftAnimationDurationMs);
    if (Number.isFinite(duration) && duration >= 0) {
      return duration;
    }

    return this.fetchIntervalMs();
  },

  projectPosition: function (plane, position, durationMs) {
    const heading = this.aircraftHeading(plane);
    const speedKt = Number(plane.speedKt);
    const rangeNm = Number(this.config.rangeNm) || this.defaults.rangeNm;

    if (!Number.isFinite(heading) || !Number.isFinite(speedKt) || speedKt <= 0 || durationMs <= 0 || rangeNm <= 0) {
      return position;
    }

    const maxDistanceNm = Number(this.config.aircraftAnimationMaxDistanceNm);
    let distanceNm = speedKt * (durationMs / 3600000);

    if (Number.isFinite(maxDistanceNm) && maxDistanceNm > 0) {
      distanceNm = Math.min(distanceNm, maxDistanceNm);
    }

    const delta = distanceNm / rangeNm * 47;
    const radians = this.toRadians(heading);

    return this.clampScopePosition({
      x: position.x + Math.sin(radians) * delta,
      y: position.y - Math.cos(radians) * delta
    });
  },

  clampScopePosition: function (position) {
    const deltaX = position.x - 50;
    const deltaY = position.y - 50;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    if (distance <= 47) {
      return position;
    }

    const scale = 47 / distance;
    return {
      x: 50 + deltaX * scale,
      y: 50 + deltaY * scale
    };
  },

  aircraftHeading: function (plane) {
    const track = Number(plane.track);
    if (Number.isFinite(track)) {
      return track;
    }

    const bearing = Number(plane.bearing);
    return Number.isFinite(bearing) ? bearing : null;
  },

  positionsAreSame: function (a, b) {
    return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  },

  statusText: function () {
    if (this.error) {
      return "Feed unavailable";
    }

    if (this.stats && this.stats.source === "demo") {
      return "Demo traffic";
    }

    return this.status || "Watching the sky";
  },

  statPill: function (value, label) {
    const pill = document.createElement("div");
    pill.className = "adsb-stat";

    const statValue = document.createElement("span");
    statValue.className = "adsb-stat-value";
    statValue.textContent = value;
    pill.appendChild(statValue);

    const statLabel = document.createElement("span");
    statLabel.className = "adsb-stat-label";
    statLabel.textContent = label;
    pill.appendChild(statLabel);

    return pill;
  },

  aircraftLabelLines: function (plane) {
    return [
      plane.flight || plane.hex || "UNKNOWN",
      plane.aircraftType || ""
    ].filter(Boolean);
  },

  aircraftTitle: function (plane) {
    return [
      plane.flight || plane.hex || "Unknown aircraft",
      plane.aircraftType || "",
      plane.registration || "",
      this.formatDistance(plane.distanceNm),
      this.formatAltitude(plane.altitudeFt),
      this.formatSpeed(plane.speedKt)
    ]
      .filter(Boolean)
      .join(" | ");
  },

  formatDistance: function (distanceNm) {
    if (typeof distanceNm !== "number") {
      return "";
    }

    if (this.config.units === "metric") {
      return `${Math.round(distanceNm * 1.852)} km`;
    }

    return `${distanceNm.toFixed(distanceNm < 10 ? 1 : 0)} nm`;
  },

  formatAltitude: function (altitudeFt) {
    if (typeof altitudeFt !== "number") {
      return "";
    }

    if (this.config.units === "metric") {
      return `${Math.round(altitudeFt * 0.3048 / 100) * 100} m`;
    }

    return `${Math.round(altitudeFt / 100) * 100} ft`;
  },

  formatSpeed: function (speedKt) {
    if (typeof speedKt !== "number") {
      return "";
    }

    if (this.config.units === "metric") {
      return `${Math.round(speedKt * 1.852)} km/h`;
    }

    return `${Math.round(speedKt)} kt`;
  },

  formatTime: function (date) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
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

  toRadians: function (degrees) {
    return (degrees * Math.PI) / 180;
  },

  toDegrees: function (radians) {
    return (radians * 180) / Math.PI;
  }
});
