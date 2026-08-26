const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadRadarModule() {
  const filePath = path.join(__dirname, "..", "MMM-ADSB-Radar.js");
  const source = fs.readFileSync(filePath, "utf8");
  let moduleDefinition = null;
  const context = {
    console,
    Log: {},
    Module: {
      register: function (name, definition) {
        assert.strictEqual(name, "MMM-ADSB-Radar");
        moduleDefinition = definition;
      }
    }
  };

  vm.runInNewContext(source, context, {
    filename: filePath
  });

  assert(moduleDefinition, "module was not registered");
  return moduleDefinition;
}

function makeInstance(config = {}) {
  const definition = loadRadarModule();
  const instance = Object.create(definition);
  instance.defaults = definition.defaults;
  instance.config = Object.assign({}, definition.defaults, config);
  return instance;
}

function relativeBounds(layout) {
  return {
    left: layout.labelLeft,
    top: layout.labelTop,
    width: layout.width,
    height: layout.height
  };
}

function connectorEnd(layout) {
  const radians = layout.connector.angleDeg * Math.PI / 180;
  return {
    x: layout.connector.left + Math.cos(radians) * layout.connector.width,
    y: layout.connector.top + Math.sin(radians) * layout.connector.width
  };
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function testEightCandidatePositions() {
  const radar = makeInstance({ radarSize: 440 });
  const metrics = radar.estimatedAircraftLabelMetrics(["AAL123", "B738"]);
  const candidates = radar.aircraftLabelCandidates({ x: 50, y: 50 }, metrics, 440, 4);

  assert.strictEqual(candidates.length, 8);
  assert.deepStrictEqual(
    new Set(candidates.map((candidate) => candidate.name)).size,
    8
  );
}

function testPrefersNonOverlappingCandidate() {
  const radar = makeInstance({ radarSize: 440, labelCollisionPadding: 4 });
  const state = { placed: [] };
  const first = radar.resolveAircraftLabelLayout({ x: 50, y: 50 }, ["AAL123", "B738"], state);
  state.placed.push(first.bounds);
  const second = radar.resolveAircraftLabelLayout({ x: 52, y: 50 }, ["UAL456", "A320"], state);
  const padding = radar.labelCollisionPaddingPx();
  const overlap = radar.rectOverlapArea(
    radar.inflateRect(first.bounds, padding),
    radar.inflateRect(second.bounds, padding)
  );

  assert.strictEqual(overlap, 0);
}

function testBoundsStayInsideScopeWhenPossible() {
  const radar = makeInstance({ radarSize: 440, labelCollisionPadding: 4 });
  const layout = radar.resolveAircraftLabelLayout({ x: 94, y: 48 }, ["N123AB", "C172"], { placed: [] });

  assert(layout.bounds.left >= 4);
  assert(layout.bounds.top >= 4);
  assert(layout.bounds.left + layout.bounds.width <= 436);
  assert(layout.bounds.top + layout.bounds.height <= 436);
  assert.strictEqual(radar.labelScopeOverflow(layout.bounds, 440, 4), 0);
}

function testConnectorTerminatesAtNearestLabelEdge() {
  const radar = makeInstance({ radarSize: 440, labelCollisionPadding: 4 });
  const layout = radar.resolveAircraftLabelLayout({ x: 50, y: 50 }, ["DAL42", "B739"], { placed: [] });
  const labelBounds = relativeBounds(layout);
  const expectedEdge = radar.nearestPointOnRect({ x: 0, y: 0 }, labelBounds);
  const actualEnd = connectorEnd(layout);
  const startDistance = distance({ x: 0, y: 0 }, {
    x: layout.connector.left,
    y: layout.connector.top
  });

  assert(startDistance >= 5.9 && startDistance <= 6.1);
  assert(distance(actualEnd, expectedEdge) <= 2.2);
  assert(layout.connector.width > 0);
}

function testDenseTrafficIsDeterministic() {
  const radar = makeInstance({ radarSize: 440, labelCollisionPadding: 4 });
  const placed = [
    { left: 210, top: 180, width: 84, height: 23 },
    { left: 130, top: 205, width: 84, height: 23 },
    { left: 250, top: 225, width: 84, height: 23 }
  ];
  const first = radar.resolveAircraftLabelLayout({ x: 50, y: 50 }, ["SWA1827", "B737"], { placed });
  const second = radar.resolveAircraftLabelLayout({ x: 50, y: 50 }, ["SWA1827", "B737"], { placed });

  assert.deepStrictEqual(second, first);
}

testEightCandidatePositions();
testPrefersNonOverlappingCandidate();
testBoundsStayInsideScopeWhenPossible();
testConnectorTerminatesAtNearestLabelEdge();
testDenseTrafficIsDeterministic();

console.log("label layout tests passed");
