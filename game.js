/*
 * Road Game Builder — core gameplay prototype.
 *
 * The file is split into small sections that only talk to each other through
 * the store, so later systems (vehicles, traffic, buildings, save/load) can be
 * added as new sections without rewriting these:
 *
 *   CONFIG        tunable numbers and colours
 *   Grid          cell maths (keys, bounds, lines between cells)
 *   Map contents  pure functions that add/remove roads and houses
 *   Store         the single source of game state + change notifications
 *   Renderer      draws the state onto the canvas
 *   Input         turns pointer events into tool strokes
 *
 * The interface is in interface.js, money and residents in city.js, saving in
 * storage.js.
 *
 * Cars live in traffic.js, house drawing in buildings.js, and traffic lights,
 * roundabouts and bridges in junctions.js; they all register
 * themselves on window.RoadGameModules and must be loaded before this file.
 *
 * Loaded as a classic script (not an ES module) so the game also runs when
 * index.html is opened straight from disk.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- CONFIG

  const CONFIG = Object.freeze({
    MIN_CELL_SIZE: 6, // CSS pixels; below this the map is clipped instead of shrinking further
    VIEWPORT_PADDING: 16,

    ROAD_WIDTH_RATIO: 0.66, // road width as a fraction of a cell
    ROAD_EDGE_RATIO: 0.05, // kerb thickness as a fraction of a cell
    SEAM_OVERLAP: 0.5, // px a road arm extends past its cell so neighbours meet without hairlines
    LANE_DASH_RATIO: 0.25, // dash and gap length as a fraction of a cell

    CROSSWALK_DISTANCE_RATIO: 0.41, // how far from a junction's centre its crossings sit
    CROSSWALK_DEPTH_RATIO: 0.1,
    JUNCTION_MIN_LINKS: 3, // a road tile with this many road neighbours is an intersection

    AUTOSAVE_DELAY_MS: 2000,
    MAX_FRAME_SECONDS: 0.05, // cap on one simulation step, e.g. after the tab was in the background
    PLACE_ANIMATION_MS: 160,
    REMOVE_ANIMATION_MS: 220,

    COLORS: Object.freeze({
      ROAD_EDGE: '#2c3035',
      ROAD_SURFACE: '#434950',
      LANE_MARKING: 'rgba(236, 233, 220, 0.75)',
      CROSSWALK: 'rgba(236, 233, 220, 0.85)',
      CAUSEWAY: '#b9ad92', // the embankment under a road built across water
      HOVER_BUILD_FILL: 'rgba(255, 255, 255, 0.20)',
      HOVER_BUILD_STROKE: 'rgba(255, 255, 255, 0.85)',
      HOVER_REMOVE_FILL: 'rgba(229, 103, 92, 0.35)',
      HOVER_REMOVE_STROKE: 'rgba(229, 103, 92, 0.95)',
      REMOVAL_DUST: '201, 181, 138',
    }),
  });

  const TOOLS = Object.freeze({
    ROAD: 'road',
    SHOP: 'shop',
    PARK: 'park',
    TOLL: 'toll',
    SIGNAL: 'signal',
    ROUNDABOUT: 'roundabout',
    BRIDGE: 'bridge',
    BULLDOZER: 'bulldozer',
  });
  /** Tools that change one existing road tile per click instead of painting along a drag. */
  const JUNCTION_TOOLS = Object.freeze([TOOLS.SIGNAL, TOOLS.ROUNDABOUT, TOOLS.BRIDGE, TOOLS.TOLL]);
  // Registered by traffic.js, buildings.js and junctions.js; checked in startGame().
  const MODULES = window.RoadGameModules || {};
  const KNOWN_TOOLS = Object.freeze(Object.values(TOOLS));

  const STATUS_HINTS = Object.freeze({
    [TOOLS.ROAD]: 'Road tool — click or drag to build',
    [TOOLS.SHOP]: 'Shop — click empty land to build a workplace. Houses appear by themselves along roads',
    [TOOLS.PARK]: 'Park — click or drag on empty land. Parks lift the mood; you want about one for every four houses',
    [TOOLS.TOLL]: 'Toll gate — click a road with no side roads. Every car pays, but gates slow traffic and annoy residents',
    [TOOLS.SIGNAL]: 'Traffic lights — click an intersection to add or remove lights',
    [TOOLS.ROUNDABOUT]: 'Roundabout — click an intersection to add or remove a roundabout',
    [TOOLS.BRIDGE]: 'Bridge — click a crossroads: once to build, again to swap which road is on top, again to remove',
    [TOOLS.BULLDOZER]: 'Bulldozer — click or drag to demolish roads, houses and shops (a small fee each)',
  });

  // ------------------------------------------------------------------ Grid

  /** Roads are stored by cell key, which is what makes duplicates impossible. */
  function cellKey(col, row) {
    return col + ',' + row;
  }

  /** `world` is the map being played; its size differs from city to city. */
  function isInBounds(cell, world) {
    return cell.col >= 0 && cell.col < world.columns && cell.row >= 0 && cell.row < world.rows;
  }

  function clampCell(cell, world) {
    return {
      col: Math.min(Math.max(cell.col, 0), world.columns - 1),
      row: Math.min(Math.max(cell.row, 0), world.rows - 1),
    };
  }

  /**
   * Cells walked when moving from one cell to another, excluding `from`.
   *
   * A fast mouse drag skips cells between two pointer events, so strokes are
   * filled in with this. Each step moves along exactly one axis (never
   * diagonally), which guarantees every cell shares an edge with the previous
   * one — i.e. a dragged road is always one connected piece.
   */
  function cellsBetween(from, to) {
    const columnDistance = Math.abs(to.col - from.col);
    const rowDistance = Math.abs(to.row - from.row);
    const columnStep = Math.sign(to.col - from.col);
    const rowStep = Math.sign(to.row - from.row);

    const cells = [];
    let columnsMoved = 0;
    let rowsMoved = 0;
    while (columnsMoved < columnDistance || rowsMoved < rowDistance) {
      // Advance whichever axis is furthest behind along the ideal straight line.
      const columnProgress = (columnsMoved + 0.5) / columnDistance;
      const rowProgress = (rowsMoved + 0.5) / rowDistance;
      if (columnProgress < rowProgress) {
        columnsMoved += 1;
      } else {
        rowsMoved += 1;
      }
      cells.push({
        col: from.col + columnsMoved * columnStep,
        row: from.row + rowsMoved * rowStep,
      });
    }
    return cells;
  }

  // ---------------------------------------------------------- Map contents
  // Roads and houses are each a set of cell keys. These functions never modify
  // the set they are given, and return the very same set when nothing changed
  // so callers can skip redundant updates.

  /** Adds cells to a set, skipping ones outside the map, already present, or occupied by `blocked`. */
  function addCells(occupied, cells, blocked) {
    const newKeys = cells
      .map((cell) => cellKey(cell.col, cell.row))
      .filter((key) => !occupied.has(key) && !blocked.has(key));
    return newKeys.length === 0 ? occupied : new Set([...occupied, ...newKeys]);
  }

  function removeCells(occupied, cells) {
    const doomedKeys = new Set(cells.map((cell) => cellKey(cell.col, cell.row)));
    const remaining = [...occupied].filter((key) => !doomedKeys.has(key));
    return remaining.length === occupied.size ? occupied : new Set(remaining);
  }

  /** Which of a cell's four neighbours are roads — this decides its shape. */
  function roadLinks(roads, col, row) {
    const north = roads.has(cellKey(col, row - 1));
    const south = roads.has(cellKey(col, row + 1));
    const west = roads.has(cellKey(col - 1, row));
    const east = roads.has(cellKey(col + 1, row));
    return { north, south, west, east, count: north + south + west + east };
  }

  function linkCountAt(roads, key) {
    const { col, row } = parseKey(key);
    return roads.has(key) ? roadLinks(roads, col, row).count : 0;
  }

  /** Adds, changes or removes the junction feature on one road tile, as the given tool dictates. */
  function toggleJunction(state, tool, cell) {
    const key = cellKey(cell.col, cell.row);
    const nextType = MODULES.nextJunctionType(tool, state.junctions.get(key), linkCountAt(state.roads, key));
    if (nextType === undefined) return state;
    const others = [...state.junctions].filter(([otherKey]) => otherKey !== key);
    return { ...state, junctions: new Map(nextType === null ? others : [...others, [key, nextType]]) };
  }

  /** Unit vector from a cell towards one neighbouring road, or null if it has none. */
  function directionToRoad(roads, col, row) {
    const links = roadLinks(roads, col, row);
    if (links.south) return { x: 0, y: 1 };
    if (links.east) return { x: 1, y: 0 };
    if (links.west) return { x: -1, y: 0 };
    if (links.north) return { x: 0, y: -1 };
    return null;
  }

  // ----------------------------------------------------------------- Store

  function createStore(initialState) {
    let state = Object.freeze(initialState);
    const listeners = [];

    return {
      getState: () => state,
      /** `updater` receives the current state and returns the next one (or the same one for "no change"). */
      update(updater) {
        const previous = state;
        const next = updater(previous);
        if (next === previous) return;
        state = Object.freeze(next);
        listeners.forEach((listener) => listener(state, previous));
      },
      subscribe(listener) {
        listeners.push(listener);
      },
    };
  }

  const GAME_SPEEDS = Object.freeze([0, 1, 3]); // 0 is paused
  const clampTax = (rate) => Math.min(Math.max(rate, MODULES.CITY.MIN_TAX), MODULES.CITY.MAX_TAX);

  /** An untouched map and a new city's books for the given world. */
  function freshMap(world) {
    return {
      world,
      water: MODULES.generateWater(world), // derived from the world; never saved
      roads: new Set(),
      houses: new Set(), // built by the residents themselves, see city.js
      shops: new Set(),
      parks: new Set(),
      junctions: new Map(), // cell key -> traffic lights, roundabout, bridge or toll gate on that road tile
      city: MODULES.initialCity(world),
    };
  }

  /**
   * The map after using a tool on some cells, money aside. Returns the same
   * state if nothing changes. A tile holds one thing: a road, a house or a shop.
   */
  function buildWithTool(state, tool, cells) {
    if (JUNCTION_TOOLS.includes(tool)) return cells.length > 0 ? toggleJunction(state, tool, cells[0]) : state;
    const isBulldozing = tool === TOOLS.BULLDOZER;
    const occupiedBy = (kinds) => new Set(kinds.flatMap((kind) => [...state[kind]]));
    /** The cells of one kind after this stroke: grown by its own tool, shrunk by the bulldozer. */
    const place = (kind, ownTool, blockers) =>
      tool === ownTool ? addCells(state[kind], cells, occupiedBy(blockers))
      : isBulldozing ? removeCells(state[kind], cells)
      : state[kind];
    const roads = place('roads', TOOLS.ROAD, ['houses', 'shops', 'parks']);
    // Roads may cross water (at a price, see city.js); buildings may not stand in it.
    const shops = place('shops', TOOLS.SHOP, ['roads', 'houses', 'parks', 'water']);
    const parks = place('parks', TOOLS.PARK, ['roads', 'houses', 'shops', 'water']);
    const houses = isBulldozing ? removeCells(state.houses, cells) : state.houses;
    const isUnchanged =
      roads === state.roads && houses === state.houses && shops === state.shops && parks === state.parks;
    if (isUnchanged) return state;
    // Changing the roads can leave a feature on a tile that no longer qualifies for it.
    const junctions = MODULES.pruneJunctions(state.junctions, (key) => linkCountAt(roads, key));
    return { ...state, roads, houses, shops, parks, junctions };
  }

  const actions = Object.freeze({
    selectTool: (tool) => (state) => {
      const isUsable = KNOWN_TOOLS.includes(tool) && MODULES.isToolUnlocked(tool, state.city);
      return !isUsable || state.activeTool === tool ? state : { ...state, activeTool: tool };
    },

    /** Building is refused outright if the tool is still locked or the city cannot pay for it. */
    applyTool: (tool, cells) => (state) => {
      if (!MODULES.isToolUnlocked(tool, state.city)) return state;
      const built = buildWithTool(state, tool, cells.filter((cell) => isInBounds(cell, state.world)));
      if (built === state) return state;
      const cost = MODULES.costOfChange(state, built);
      if (cost > state.city.money) return state;
      return { ...built, city: { ...state.city, money: state.city.money - cost } };
    },

    setTaxRate: (rate) => (state) => {
      if (!Number.isFinite(rate)) return state;
      const taxRate = clampTax(Math.round(rate));
      return taxRate === state.city.taxRate ? state : { ...state, city: { ...state.city, taxRate } };
    },

    setSpeed: (speed) => (state) =>
      !GAME_SPEEDS.includes(speed) || speed === state.speed ? state : { ...state, speed },

    earn: (amount) => (state) =>
      amount > 0 ? { ...state, city: { ...state.city, money: state.city.money + amount } } : state,

    /** Starts play in a save slot with the given world, map and city. */
    enterWorld: (slot, map) => (state) => ({
      ...state,
      ...map,
      water: MODULES.generateWater(map.world),
      slot,
      speed: 1,
      activeTool: TOOLS.ROAD,
    }),

    /** Stops the clock and marks that no city is being played (the welcome screen is showing). */
    exitToMenu: () => (state) => (state.slot === null && state.speed === 0 ? state : { ...state, slot: null, speed: 0 }),
  });

  // -------------------------------------------------------------- Renderer

  function parseKey(key) {
    const [col, row] = key.split(',').map(Number);
    return { col, row };
  }

  /** Traces one road tile: a round hub plus an arm towards each linked neighbour. */
  function traceRoadTile(ctx, centerX, centerY, cellSize, width, links) {
    const half = width / 2;
    const reach = cellSize / 2 + CONFIG.SEAM_OVERLAP;

    ctx.beginPath();
    if (links.count === 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(centerX - half, centerY - half, width, width, width * 0.28);
      return;
    }
    ctx.arc(centerX, centerY, half, 0, Math.PI * 2);
    if (links.north) ctx.rect(centerX - half, centerY - reach, width, reach);
    if (links.south) ctx.rect(centerX - half, centerY, width, reach);
    if (links.west) ctx.rect(centerX - reach, centerY - half, reach, width);
    if (links.east) ctx.rect(centerX, centerY - half, reach, width);
  }

  function createRenderer(canvas, viewport, store, { traffic, drawHouse }) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser does not support the 2D canvas.');

    const prefersReducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // View-only state. None of this is game state — it can be thrown away at any time.
    let cellSize = CONFIG.MIN_CELL_SIZE;
    let pixelRatio = 1;
    let hover = null; // { cell, toolOverride }
    let isFrameRequested = false;
    const placedAt = new Map(); // cell key -> time a road or house appeared (for the grow-in animation)
    let removals = []; // [{ col, row, time }] cells that were just bulldozed

    function requestRender() {
      if (isFrameRequested) return;
      isFrameRequested = true;
      window.requestAnimationFrame(draw);
    }

    /** Fits the whole grid inside the viewport using the largest whole-pixel cell size. */
    function resize() {
      const availableWidth = viewport.clientWidth - CONFIG.VIEWPORT_PADDING * 2;
      const availableHeight = viewport.clientHeight - CONFIG.VIEWPORT_PADDING * 2;
      const fittingCellSize = Math.floor(
        Math.min(availableWidth / store.getState().world.columns, availableHeight / store.getState().world.rows)
      );
      cellSize = Math.max(CONFIG.MIN_CELL_SIZE, fittingCellSize);
      pixelRatio = window.devicePixelRatio || 1;

      const width = cellSize * store.getState().world.columns;
      const height = cellSize * store.getState().world.rows;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      requestRender();
    }

    function drawTerrain() {
      const { world, water, roads, houses, shops, parks } = store.getState();
      MODULES.drawTerrain(ctx, {
        columns: world.columns,
        rows: world.rows,
        cellSize,
        isWater: (col, row) => water.has(cellKey(col, row)),
        isBuiltOn: (col, row) => [roads, houses, shops, parks].some((tiles) => tiles.has(cellKey(col, row))),
      });
    }

    /** 0..1 growth of a freshly placed tile; 1 once its animation has finished. */
    function placementScale(key, now) {
      const startedAt = placedAt.get(key);
      if (startedAt === undefined) return 1;
      const progress = Math.min((now - startedAt) / CONFIG.PLACE_ANIMATION_MS, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      return 0.45 + 0.55 * eased;
    }

    function describeTiles(roads, now) {
      return [...roads].map((key) => {
        const { col, row } = parseKey(key);
        return {
          key,
          centerX: (col + 0.5) * cellSize,
          centerY: (row + 0.5) * cellSize,
          links: roadLinks(roads, col, row),
          scale: placementScale(key, now),
        };
      });
    }

    function drawLaneMarkings(tiles) {
      const dash = cellSize * CONFIG.LANE_DASH_RATIO;
      const reach = cellSize / 2;
      ctx.beginPath();
      tiles.forEach(({ centerX, centerY, links }) => {
        // Junctions (3+ links) are left unmarked, like a real intersection.
        if (links.count === 0 || links.count > 2) return;
        if (links.north) { ctx.moveTo(centerX, centerY); ctx.lineTo(centerX, centerY - reach); }
        if (links.south) { ctx.moveTo(centerX, centerY); ctx.lineTo(centerX, centerY + reach); }
        if (links.west) { ctx.moveTo(centerX, centerY); ctx.lineTo(centerX - reach, centerY); }
        if (links.east) { ctx.moveTo(centerX, centerY); ctx.lineTo(centerX + reach, centerY); }
      });
      // The dash pattern restarts on every arm; the offset centres one dash on
      // each half-cell so markings line up from tile to tile.
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = dash * 1.5;
      ctx.strokeStyle = CONFIG.COLORS.LANE_MARKING;
      ctx.lineWidth = Math.max(1, cellSize * 0.05);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /** Zebra crossings on every arm of a junction — this is what marks a tile as an intersection. */
    function drawCrosswalks(tiles) {
      const distance = cellSize * CONFIG.CROSSWALK_DISTANCE_RATIO;
      const halfSpan = (cellSize * CONFIG.ROAD_WIDTH_RATIO) / 2;
      const stripe = cellSize * 0.07;
      ctx.beginPath();
      tiles.forEach(({ centerX, centerY, links }) => {
        if (links.count < CONFIG.JUNCTION_MIN_LINKS) return;
        if (links.north) { ctx.moveTo(centerX - halfSpan, centerY - distance); ctx.lineTo(centerX + halfSpan, centerY - distance); }
        if (links.south) { ctx.moveTo(centerX - halfSpan, centerY + distance); ctx.lineTo(centerX + halfSpan, centerY + distance); }
        if (links.west) { ctx.moveTo(centerX - distance, centerY - halfSpan); ctx.lineTo(centerX - distance, centerY + halfSpan); }
        if (links.east) { ctx.moveTo(centerX + distance, centerY - halfSpan); ctx.lineTo(centerX + distance, centerY + halfSpan); }
      });
      ctx.setLineDash([stripe, stripe]);
      ctx.lineDashOffset = stripe / 2;
      ctx.strokeStyle = CONFIG.COLORS.CROSSWALK;
      ctx.lineWidth = cellSize * CONFIG.CROSSWALK_DEPTH_RATIO;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const ROAD_COLORS = Object.freeze({
      edge: CONFIG.COLORS.ROAD_EDGE,
      surface: CONFIG.COLORS.ROAD_SURFACE,
      marking: CONFIG.COLORS.LANE_MARKING,
    });

    function junctionDetails(tile, type) {
      return { ...tile, type, cellSize, roadColors: ROAD_COLORS, roadWidth: cellSize * CONFIG.ROAD_WIDTH_RATIO };
    }

    /** Roundabouts and traffic lights, on top of the finished road surface. */
    function drawGroundJunctions(tiles, junctions) {
      const phase = MODULES.signalPhase(traffic.getClockSeconds());
      tiles
        .filter((tile) => junctions.has(tile.key))
        .forEach((tile) => MODULES.drawJunction(ctx, { ...junctionDetails(tile, junctions.get(tile.key)), phase }));
    }

    function drawBridgeDecks(roads, junctions) {
      junctions.forEach((type, key) => {
        if (!MODULES.isBridge(type)) return;
        const { col, row } = parseKey(key);
        const tile = { centerX: (col + 0.5) * cellSize, centerY: (row + 0.5) * cellSize };
        MODULES.drawBridgeDeck(ctx, junctionDetails(tile, type));
      });
    }

    function drawShops(shops, roads, now) {
      shops.forEach((key) => {
        const { col, row } = parseKey(key);
        MODULES.drawShop(ctx, {
          col,
          row,
          cellSize,
          scale: placementScale(key, now),
          drivewayDirection: directionToRoad(roads, col, row),
        });
      });
    }

    function drawHouses(houses, roads, now) {
      houses.forEach((key) => {
        const { col, row } = parseKey(key);
        drawHouse(ctx, {
          col,
          row,
          cellSize,
          scale: placementScale(key, now),
          drivewayDirection: directionToRoad(roads, col, row),
        });
      });
    }

    function drawRoads(roads, junctions, now) {
      const tiles = describeTiles(roads, now);
      const { water } = store.getState();
      ctx.fillStyle = CONFIG.COLORS.CAUSEWAY;
      tiles.filter((tile) => water.has(tile.key)).forEach((tile) =>
        ctx.fillRect(tile.centerX - cellSize / 2, tile.centerY - cellSize / 2, cellSize, cellSize));
      const surfaceWidth = cellSize * CONFIG.ROAD_WIDTH_RATIO;
      const edgeWidth = surfaceWidth + Math.max(2, cellSize * CONFIG.ROAD_EDGE_RATIO * 2);

      // Two passes so one tile's kerb never paints over a neighbour's surface.
      ctx.fillStyle = CONFIG.COLORS.ROAD_EDGE;
      tiles.forEach((tile) => {
        traceRoadTile(ctx, tile.centerX, tile.centerY, cellSize, edgeWidth * tile.scale, tile.links);
        ctx.fill();
      });
      ctx.fillStyle = CONFIG.COLORS.ROAD_SURFACE;
      tiles.forEach((tile) => {
        traceRoadTile(ctx, tile.centerX, tile.centerY, cellSize, surfaceWidth * tile.scale, tile.links);
        ctx.fill();
      });
      drawLaneMarkings(tiles);
      // Zebra crossings only where roads meet at grade and there is no roundabout in the way.
      const isPlainOrSignalled = (tile) =>
        !junctions.has(tile.key) || junctions.get(tile.key) === MODULES.JUNCTION.SIGNAL;
      drawCrosswalks(tiles.filter(isPlainOrSignalled));
      drawGroundJunctions(tiles, junctions);
    }

    function drawRemovals(now) {
      removals.forEach(({ col, row, time }) => {
        const progress = Math.min((now - time) / CONFIG.REMOVE_ANIMATION_MS, 1);
        const inset = cellSize * (0.15 + 0.2 * progress);
        ctx.fillStyle = 'rgba(' + CONFIG.COLORS.REMOVAL_DUST + ', ' + (0.55 * (1 - progress)).toFixed(3) + ')';
        ctx.fillRect(col * cellSize + inset, row * cellSize + inset, cellSize - inset * 2, cellSize - inset * 2);
      });
    }

    function drawHover(activeTool) {
      if (!hover) return;
      const isRemoving = (hover.toolOverride || activeTool) === TOOLS.BULLDOZER;
      const x = hover.cell.col * cellSize + 1.5;
      const y = hover.cell.row * cellSize + 1.5;
      const size = cellSize - 3;
      ctx.fillStyle = isRemoving ? CONFIG.COLORS.HOVER_REMOVE_FILL : CONFIG.COLORS.HOVER_BUILD_FILL;
      ctx.strokeStyle = isRemoving ? CONFIG.COLORS.HOVER_REMOVE_STROKE : CONFIG.COLORS.HOVER_BUILD_STROKE;
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, size, size);
      ctx.strokeRect(x, y, size, size);
    }

    function pruneFinishedAnimations(now) {
      placedAt.forEach((startedAt, key) => {
        if (now - startedAt >= CONFIG.PLACE_ANIMATION_MS) placedAt.delete(key);
      });
      removals = removals.filter(({ time }) => now - time < CONFIG.REMOVE_ANIMATION_MS);
    }

    function draw() {
      isFrameRequested = false;
      const now = performance.now();
      const { roads, houses, shops, parks, junctions, activeTool } = store.getState();

      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      drawTerrain();
      drawRemovals(now);
      parks.forEach((key) => MODULES.drawPark(ctx, { ...parseKey(key), cellSize, scale: placementScale(key, now) }));
      drawHouses(houses, roads, now);
      drawShops(shops, roads, now);
      drawRoads(roads, junctions, now);
      traffic.draw(ctx, cellSize);
      drawBridgeDecks(roads, junctions);
      traffic.draw(ctx, cellSize, { isDeckLayer: true });
      drawHover(activeTool);

      pruneFinishedAnimations(now);
      if (placedAt.size > 0 || removals.length > 0) requestRender();
    }

    /** Starts grow-in / dust animations for whatever changed between two sets of roads or houses. */
    function trackTileChanges(tiles, previousTiles) {
      if (prefersReducedMotion || tiles === previousTiles) return;
      const now = performance.now();
      tiles.forEach((key) => {
        if (!previousTiles.has(key)) placedAt.set(key, now);
      });
      const removed = [...previousTiles]
        .filter((key) => !tiles.has(key))
        .map((key) => ({ ...parseKey(key), time: now }));
      removed.forEach(({ col, row }) => placedAt.delete(cellKey(col, row)));
      removals = [...removals, ...removed];
    }

    store.subscribe((state, previous) => {
      if (state.world !== previous.world) resize();
      trackTileChanges(state.roads, previous.roads);
      trackTileChanges(state.houses, previous.houses);
      trackTileChanges(state.shops, previous.shops);
      trackTileChanges(state.parks, previous.parks);
      requestRender();
    });

    return {
      resize,
      requestRender,
      setHover(cell, toolOverride) {
        hover = cell ? { cell, toolOverride: toolOverride || null } : null;
        requestRender();
      },
    };
  }

  // ----------------------------------------------------------------- Input

  /**
   * Wires the pointer to the active tool. A "stroke" lasts from pointer-down
   * to pointer-up; the pointer is captured for its duration so a drag keeps
   * working (clamped to the map edge) even if the cursor leaves the canvas.
   */
  function attachInput(canvas, store, onHoverChange) {
    const PRIMARY_BUTTON = 0;
    const SECONDARY_BUTTON = 2;
    let stroke = null; // { pointerId, tool, lastCell }

    function cellFromEvent(event) {
      const bounds = canvas.getBoundingClientRect();
      return {
        col: Math.floor(((event.clientX - bounds.left) / bounds.width) * store.getState().world.columns),
        row: Math.floor(((event.clientY - bounds.top) / bounds.height) * store.getState().world.rows),
      };
    }

    function endStroke(event) {
      if (!stroke || event.pointerId !== stroke.pointerId) return;
      stroke = null;
      const cell = cellFromEvent(event);
      onHoverChange(event.type === 'pointerup' && isInBounds(cell, store.getState().world) ? cell : null, null);
    }

    canvas.addEventListener('pointerdown', (event) => {
      if (stroke || (event.button !== PRIMARY_BUTTON && event.button !== SECONDARY_BUTTON)) return;
      event.preventDefault();
      const cell = clampCell(cellFromEvent(event), store.getState().world);
      // Right button always bulldozes, whichever tool is selected.
      const tool = event.button === SECONDARY_BUTTON ? TOOLS.BULLDOZER : store.getState().activeTool;
      stroke = { pointerId: event.pointerId, tool, lastCell: cell };
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        // Capture is a nicety (drags that leave the canvas); building still works without it.
        console.warn('Pointer capture unavailable:', error);
      }
      store.update(actions.applyTool(tool, [cell]));
      onHoverChange(cell, tool);
    });

    canvas.addEventListener('pointermove', (event) => {
      const rawCell = cellFromEvent(event);
      if (!stroke) {
        onHoverChange(isInBounds(rawCell, store.getState().world) ? rawCell : null, null);
        return;
      }
      if (event.pointerId !== stroke.pointerId) return;
      const cell = clampCell(rawCell, store.getState().world);
      if (cell.col === stroke.lastCell.col && cell.row === stroke.lastCell.row) return;
      // Junction tools act once per click; dragging with them only moves the highlight.
      if (!JUNCTION_TOOLS.includes(stroke.tool)) {
        store.update(actions.applyTool(stroke.tool, cellsBetween(stroke.lastCell, cell)));
      }
      stroke = { ...stroke, lastCell: cell };
      onHoverChange(cell, stroke.tool);
    });

    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);
    canvas.addEventListener('lostpointercapture', endStroke);
    canvas.addEventListener('pointerleave', () => {
      if (!stroke) onHoverChange(null, null);
    });
    // Right-drag is the quick bulldozer, so the browser menu must stay closed.
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // ------------------------------------------------------------------ Boot

  function watchViewportSize(viewport, onResize) {
    if (typeof window.ResizeObserver === 'function') {
      new window.ResizeObserver(onResize).observe(viewport);
      return;
    }
    window.addEventListener('resize', onResize);
  }

  function showFatalError(error) {
    console.error('Road Game Builder failed to start:', error);
    const banner = document.getElementById('error-banner');
    if (!banner) return;
    banner.textContent = 'Road Game Builder could not start: ' + error.message;
    banner.hidden = false;
  }

  const requireElement = (id) => MODULES.requireElement(id);

  function requireModules() {
    const required = [
      'createTraffic', 'drawHouse', 'drawShop', 'drawPark', 'drawTerrain', 'nextJunctionType', 'pruneJunctions', 'signalPhase', 'drawJunction',
      'drawBridgeDeck', 'isBridge', 'createCity', 'initialCity', 'costOfChange', 'isToolUnlocked', 'attachInterface',
      'requireElement', 'serializeGame', 'parseSave', 'startAutosave', 'createCloud', 'startCloudUpload', 'startMenu',
      'sanitizeWorld', 'generateWater', 'difficultyOf',
    ];
    const missing = required.filter((name) => typeof MODULES[name] !== 'function');
    if (missing.length > 0 || !MODULES.JUNCTION || !MODULES.CITY) {
      throw new Error('A game script failed to load before game.js (missing: ' + missing.join(', ') + ').');
    }
    return MODULES;
  }

  /** Runs traffic and the city forward every frame (several times per frame when sped up). */
  function startGameLoop(store, traffic, city, renderer, ui) {
    let previousTime = performance.now();
    function frame(now) {
      const deltaSeconds = Math.min((now - previousTime) / 1000, CONFIG.MAX_FRAME_SECONDS);
      previousTime = now;
      const { speed } = store.getState();
      for (let pass = 0; pass < speed; pass += 1) {
        const state = store.getState();
        traffic.step(deltaSeconds, state.roads, state.houses, state.shops, state.junctions);
        const afterCityTick = city.tick(deltaSeconds, state, traffic.getCongestion());
        store.update(() => afterCityTick);
        store.update(actions.earn(traffic.collectTolls() * MODULES.CITY.TOLL_FEE));
      }
      ui.showTraffic(traffic.getCarCount(), traffic.getCongestion());
      // Traffic lights change colour even on an empty road, so they keep the map redrawing too.
      const isAnythingMoving = traffic.getCarCount() > 0 || store.getState().junctions.size > 0;
      if (speed > 0 && isAnythingMoving) renderer.requestRender();
      window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  /** What storage.js needs to know to check a save, wherever it came from. */
  function saveRules() {
    return {
      sanitizeWorld: MODULES.sanitizeWorld,
      isValidCell: (key, world) => isInBounds(parseKey(key), world),
      junctionTypes: Object.values(MODULES.JUNCTION),
      defaultCity: MODULES.initialCity,
      clampTax,
    };
  }

  function startGame() {
    const { createTraffic, createCity, drawHouse, JUNCTION, signalPhase, attachInterface } = requireModules();
    const canvas = requireElement('game-canvas');
    const viewport = requireElement('viewport');
    // Until the player picks a city on the welcome screen, an empty default world sits paused behind it.
    const placeholder = freshMap(MODULES.sanitizeWorld(null));
    const store = createStore({ ...placeholder, slot: null, activeTool: TOOLS.ROAD, speed: 0 });

    const traffic = createTraffic({ cellKey, JUNCTION, signalPhase });
    const city = createCity({ cellKey });
    const renderer = createRenderer(canvas, viewport, store, { traffic, drawHouse });
    const ui = attachInterface(store, canvas, { actions, TOOLS, STATUS_HINTS });
    attachInput(canvas, store, (cell, toolOverride) => {
      renderer.setHover(cell, toolOverride);
      ui.showCursorCell(cell);
    });

    watchViewportSize(viewport, renderer.resize);
    renderer.resize();
    MODULES.startAutosave(store, CONFIG.AUTOSAVE_DELAY_MS);
    const cloud = MODULES.createCloud(window.ROAD_GAME_CONFIG);
    const menu = MODULES.startMenu({ store, actions, rules: saveRules(), freshMap, cloud });
    MODULES.startCloudUpload({
      cloud,
      store,
      serialize: MODULES.serializeGame,
      getUser: menu.getUser,
      markOwned: MODULES.setSlotOwner,
      savedParts: MODULES.SAVED_PARTS,
    });
    startGameLoop(store, traffic, city, renderer, ui);

    // Read-only window into the game for debugging from the browser console.
    window.roadGameBuilder = Object.freeze({ getState: store.getState });
  }

  try {
    startGame();
  } catch (error) {
    showFatalError(error);
  }
})();
