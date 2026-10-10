/*
 * Road Game Builder — junction features: traffic lights, roundabouts, bridges.
 *
 * A feature is a label attached to one road tile. This file holds the rules
 * for where a feature may stand, the traffic-light timing, and the drawing.
 * How cars behave at each feature lives in traffic.js.
 */
(function () {
  'use strict';

  const JUNCTION = Object.freeze({
    SIGNAL: 'signal',
    ROUNDABOUT: 'roundabout',
    BRIDGE_EW: 'bridge-ew', // east–west road on top, north–south passes underneath
    BRIDGE_NS: 'bridge-ns',
    TOLL: 'toll', // a gate on a plain stretch of road
  });

  // Tool ids, matching TOOLS in game.js.
  const JUNCTION_TOOLS = Object.freeze({ SIGNAL: 'signal', ROUNDABOUT: 'roundabout', BRIDGE: 'bridge', TOLL: 'toll' });

  const RULES = Object.freeze({
    MIN_LINKS_FOR_JUNCTION: 3, // lights and roundabouts need a real intersection
    LINKS_FOR_BRIDGE: 4, // a bridge needs two roads crossing
    LINKS_FOR_TOLL: 2, // a toll gate stands on a road with no side roads
    GREEN_SECONDS: 4,
    YELLOW_SECONDS: 1,
  });

  const LOOK = Object.freeze({
    // Sizes are fractions of a tile.
    ROUNDABOUT_RADIUS: 0.5,
    ISLAND_RADIUS: 0.15,
    LIGHT_ALONG: 0.42,
    LIGHT_ASIDE: 0.41,
    LIGHT_RADIUS: 0.07,
    BRIDGE_RAIL: 0.08,
    BRIDGE_SHADOW_OFFSET: 0.09,

    ISLAND_COLOR: '#8fc27a',
    ISLAND_RING_COLOR: 'rgba(236, 233, 220, 0.8)',
    LIGHT_HOUSING_COLOR: '#15191c',
    LIGHT_COLORS: Object.freeze({ green: '#4cd964', yellow: '#f5c542', red: '#f0483e' }),
    BRIDGE_RAIL_COLOR: '#c5c9cd',
    BRIDGE_SHADOW_COLOR: 'rgba(0, 0, 0, 0.3)',
    TOLL_DEPTH: 0.26,
    TOLL_OVERHANG: 1.35, // canopy width relative to the road
    TOLL_CANOPY_COLOR: '#e9c44a',
    TOLL_BOOTH_COLOR: '#2b3035',
  });

  const isBridge = (type) => type === JUNCTION.BRIDGE_EW || type === JUNCTION.BRIDGE_NS;

  function isAllowed(type, linkCount) {
    if (type === JUNCTION.TOLL) return linkCount === RULES.LINKS_FOR_TOLL;
    return isBridge(type) ? linkCount === RULES.LINKS_FOR_BRIDGE : linkCount >= RULES.MIN_LINKS_FOR_JUNCTION;
  }

  /**
   * What a click with a junction tool turns a tile into: a feature type, null
   * to remove the current feature, or undefined if the click does nothing.
   * The bridge tool cycles: east–west on top, north–south on top, removed.
   */
  function nextJunctionType(tool, currentType, linkCount) {
    if (tool === JUNCTION_TOOLS.TOLL) {
      if (linkCount !== RULES.LINKS_FOR_TOLL) return undefined;
      return currentType === JUNCTION.TOLL ? null : JUNCTION.TOLL;
    }
    if (tool === JUNCTION_TOOLS.BRIDGE) {
      if (linkCount !== RULES.LINKS_FOR_BRIDGE) return undefined;
      if (currentType === JUNCTION.BRIDGE_EW) return JUNCTION.BRIDGE_NS;
      return currentType === JUNCTION.BRIDGE_NS ? null : JUNCTION.BRIDGE_EW;
    }
    const wanted = tool === JUNCTION_TOOLS.SIGNAL ? JUNCTION.SIGNAL : JUNCTION.ROUNDABOUT;
    if (linkCount < RULES.MIN_LINKS_FOR_JUNCTION) return undefined;
    return currentType === wanted ? null : wanted;
  }

  /** Drops features whose tile no longer qualifies (e.g. a road arm was bulldozed). */
  function pruneJunctions(junctions, linkCountOf) {
    const kept = [...junctions].filter(([key, type]) => isAllowed(type, linkCountOf(key)));
    return kept.length === junctions.size ? junctions : new Map(kept);
  }

  /** Light colour for each axis. All traffic lights on the map share one clock. */
  function signalPhase(clockSeconds) {
    const half = RULES.GREEN_SECONDS + RULES.YELLOW_SECONDS;
    const time = clockSeconds % (half * 2);
    const active = time % half < RULES.GREEN_SECONDS ? 'green' : 'yellow';
    return time < half ? { ns: active, ew: 'red' } : { ns: 'red', ew: active };
  }

  function fillCircle(ctx, x, y, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawRoundabout(ctx, { centerX, centerY, cellSize, roadColors }) {
    const radius = LOOK.ROUNDABOUT_RADIUS * cellSize;
    fillCircle(ctx, centerX, centerY, radius, roadColors.edge);
    fillCircle(ctx, centerX, centerY, radius - Math.max(1, cellSize * 0.05), roadColors.surface);
    fillCircle(ctx, centerX, centerY, LOOK.ISLAND_RADIUS * cellSize + Math.max(1, cellSize * 0.03), LOOK.ISLAND_RING_COLOR);
    fillCircle(ctx, centerX, centerY, LOOK.ISLAND_RADIUS * cellSize, LOOK.ISLAND_COLOR);
  }

  /** One light per arm, standing on the right-hand side of traffic approaching the junction. */
  function drawSignals(ctx, { centerX, centerY, cellSize, links, phase }) {
    const arms = [
      { isLinked: links.north, x: 0, y: -1, color: phase.ns },
      { isLinked: links.south, x: 0, y: 1, color: phase.ns },
      { isLinked: links.east, x: 1, y: 0, color: phase.ew },
      { isLinked: links.west, x: -1, y: 0, color: phase.ew },
    ];
    arms.filter((arm) => arm.isLinked).forEach((arm) => {
      const x = centerX + (arm.x * LOOK.LIGHT_ALONG + arm.y * LOOK.LIGHT_ASIDE) * cellSize;
      const y = centerY + (arm.y * LOOK.LIGHT_ALONG - arm.x * LOOK.LIGHT_ASIDE) * cellSize;
      fillCircle(ctx, x, y, LOOK.LIGHT_RADIUS * cellSize * 1.5, LOOK.LIGHT_HOUSING_COLOR);
      fillCircle(ctx, x, y, LOOK.LIGHT_RADIUS * cellSize, LOOK.LIGHT_COLORS[arm.color]);
    });
  }

  /** A canopy across the road with a booth at each end. */
  function drawToll(ctx, { centerX, centerY, cellSize, links, roadWidth }) {
    const isRoadVertical = links.north || links.south;
    const span = roadWidth * LOOK.TOLL_OVERHANG;
    const depth = LOOK.TOLL_DEPTH * cellSize;
    const width = isRoadVertical ? span : depth;
    const height = isRoadVertical ? depth : span;
    const booth = depth * 0.8;
    ctx.fillStyle = LOOK.TOLL_CANOPY_COLOR;
    ctx.fillRect(centerX - width / 2, centerY - height / 2, width, height);
    ctx.fillStyle = LOOK.TOLL_BOOTH_COLOR;
    [-1, 1].forEach((side) => {
      const x = centerX + (isRoadVertical ? (side * (span - booth)) / 2 : 0);
      const y = centerY + (isRoadVertical ? 0 : (side * (span - booth)) / 2);
      ctx.fillRect(x - booth / 2, y - booth / 2, booth, booth);
    });
  }

  /** Ground-level features, drawn on top of the plain road tile. */
  function drawJunction(ctx, details) {
    if (details.type === JUNCTION.TOLL) drawToll(ctx, details);
    if (details.type === JUNCTION.ROUNDABOUT) drawRoundabout(ctx, details);
    if (details.type === JUNCTION.SIGNAL) drawSignals(ctx, details);
  }

  /** The upper road of a bridge. Drawn after the cars passing underneath it. */
  function drawBridgeDeck(ctx, { type, centerX, centerY, cellSize, roadWidth, roadColors }) {
    const isEastWest = type === JUNCTION.BRIDGE_EW;
    const half = cellSize / 2;
    const rail = Math.max(1.5, LOOK.BRIDGE_RAIL * cellSize);
    const band = (across, offset, color) => {
      ctx.fillStyle = color;
      if (isEastWest) ctx.fillRect(centerX - half, centerY - across / 2 + offset, cellSize, across);
      else ctx.fillRect(centerX - across / 2 + offset, centerY - half, across, cellSize);
    };
    band(roadWidth + rail * 2, LOOK.BRIDGE_SHADOW_OFFSET * cellSize, LOOK.BRIDGE_SHADOW_COLOR);
    band(roadWidth + rail * 2, 0, LOOK.BRIDGE_RAIL_COLOR);
    band(roadWidth, 0, roadColors.surface);

    const dash = cellSize * 0.25;
    ctx.beginPath();
    ctx.moveTo(centerX - (isEastWest ? half : 0), centerY - (isEastWest ? 0 : half));
    ctx.lineTo(centerX + (isEastWest ? half : 0), centerY + (isEastWest ? 0 : half));
    ctx.setLineDash([dash, dash]);
    ctx.lineDashOffset = -dash / 2;
    ctx.strokeStyle = roadColors.marking;
    ctx.lineWidth = Math.max(1, cellSize * 0.05);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, {
    JUNCTION,
    isBridge,
    nextJunctionType,
    pruneJunctions,
    signalPhase,
    drawJunction,
    drawBridgeDeck,
  });
})();
