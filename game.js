/*
 * Road Game Builder — core gameplay prototype.
 *
 * The file is split into small sections that only talk to each other through
 * the store, so later systems (vehicles, traffic, buildings, save/load) can be
 * added as new sections without rewriting these:
 *
 *   CONFIG        tunable numbers and colours
 *   Grid          cell maths (keys, bounds, lines between cells)
 *   Road network  pure functions that add/remove road segments
 *   Store         the single source of game state + change notifications
 *   Renderer      draws the state onto the canvas
 *   Input         turns pointer events into tool strokes
 *   Interface     toolbar, counter, clear-map dialog, keyboard shortcuts
 *
 * Loaded as a classic script (not an ES module) so the game also runs when
 * index.html is opened straight from disk.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- CONFIG

  const CONFIG = Object.freeze({
    GRID_COLUMNS: 40,
    GRID_ROWS: 24,
    MIN_CELL_SIZE: 6, // CSS pixels; below this the map is clipped instead of shrinking further
    VIEWPORT_PADDING: 16,

    ROAD_WIDTH_RATIO: 0.66, // road width as a fraction of a cell
    ROAD_EDGE_RATIO: 0.05, // kerb thickness as a fraction of a cell
    SEAM_OVERLAP: 0.5, // px a road arm extends past its cell so neighbours meet without hairlines
    LANE_DASH_RATIO: 0.25, // dash and gap length as a fraction of a cell

    PLACE_ANIMATION_MS: 160,
    REMOVE_ANIMATION_MS: 220,

    COLORS: Object.freeze({
      TERRAIN: '#84b870',
      GRID_LINE: 'rgba(28, 64, 30, 0.10)',
      ROAD_EDGE: '#2c3035',
      ROAD_SURFACE: '#434950',
      LANE_MARKING: 'rgba(236, 233, 220, 0.75)',
      HOVER_BUILD_FILL: 'rgba(255, 255, 255, 0.20)',
      HOVER_BUILD_STROKE: 'rgba(255, 255, 255, 0.85)',
      HOVER_REMOVE_FILL: 'rgba(229, 103, 92, 0.35)',
      HOVER_REMOVE_STROKE: 'rgba(229, 103, 92, 0.95)',
      REMOVAL_DUST: '201, 181, 138',
    }),
  });

  const TOOLS = Object.freeze({ ROAD: 'road', BULLDOZER: 'bulldozer' });
  const KNOWN_TOOLS = Object.freeze(Object.values(TOOLS));

  const STATUS_HINTS = Object.freeze({
    [TOOLS.ROAD]: 'Road tool — click or drag to build',
    [TOOLS.BULLDOZER]: 'Bulldozer — click or drag over roads to remove them',
  });

  // ------------------------------------------------------------------ Grid

  /** Roads are stored by cell key, which is what makes duplicates impossible. */
  function cellKey(col, row) {
    return col + ',' + row;
  }

  function isInBounds(cell) {
    return (
      cell.col >= 0 && cell.col < CONFIG.GRID_COLUMNS && cell.row >= 0 && cell.row < CONFIG.GRID_ROWS
    );
  }

  function clampCell(cell) {
    return {
      col: Math.min(Math.max(cell.col, 0), CONFIG.GRID_COLUMNS - 1),
      row: Math.min(Math.max(cell.row, 0), CONFIG.GRID_ROWS - 1),
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

  // ---------------------------------------------------------- Road network
  // Pure functions: they never modify the set they are given, and return the
  // very same set when nothing changed so callers can skip redundant updates.

  function addRoads(roads, cells) {
    const newKeys = cells
      .filter(isInBounds)
      .map((cell) => cellKey(cell.col, cell.row))
      .filter((key) => !roads.has(key));
    return newKeys.length === 0 ? roads : new Set([...roads, ...newKeys]);
  }

  function removeRoads(roads, cells) {
    const doomedKeys = new Set(cells.map((cell) => cellKey(cell.col, cell.row)));
    const remaining = [...roads].filter((key) => !doomedKeys.has(key));
    return remaining.length === roads.size ? roads : new Set(remaining);
  }

  /** Which of a cell's four neighbours are roads — this decides its shape. */
  function roadLinks(roads, col, row) {
    const north = roads.has(cellKey(col, row - 1));
    const south = roads.has(cellKey(col, row + 1));
    const west = roads.has(cellKey(col - 1, row));
    const east = roads.has(cellKey(col + 1, row));
    return { north, south, west, east, count: north + south + west + east };
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

  const actions = Object.freeze({
    selectTool: (tool) => (state) =>
      !KNOWN_TOOLS.includes(tool) || state.activeTool === tool ? state : { ...state, activeTool: tool },

    applyTool: (tool, cells) => (state) => {
      const roads = tool === TOOLS.BULLDOZER ? removeRoads(state.roads, cells) : addRoads(state.roads, cells);
      return roads === state.roads ? state : { ...state, roads };
    },

    clearMap: () => (state) => (state.roads.size === 0 ? state : { ...state, roads: new Set() }),
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

  function createRenderer(canvas, viewport, store) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser does not support the 2D canvas.');

    const prefersReducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // View-only state. None of this is game state — it can be thrown away at any time.
    let cellSize = CONFIG.MIN_CELL_SIZE;
    let pixelRatio = 1;
    let hover = null; // { cell, toolOverride }
    let isFrameRequested = false;
    const placedAt = new Map(); // road key -> time it appeared (for the grow-in animation)
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
        Math.min(availableWidth / CONFIG.GRID_COLUMNS, availableHeight / CONFIG.GRID_ROWS)
      );
      cellSize = Math.max(CONFIG.MIN_CELL_SIZE, fittingCellSize);
      pixelRatio = window.devicePixelRatio || 1;

      const width = cellSize * CONFIG.GRID_COLUMNS;
      const height = cellSize * CONFIG.GRID_ROWS;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      requestRender();
    }

    function drawTerrain() {
      const width = cellSize * CONFIG.GRID_COLUMNS;
      const height = cellSize * CONFIG.GRID_ROWS;
      ctx.fillStyle = CONFIG.COLORS.TERRAIN;
      ctx.fillRect(0, 0, width, height);

      ctx.beginPath();
      for (let col = 1; col < CONFIG.GRID_COLUMNS; col += 1) {
        ctx.moveTo(col * cellSize + 0.5, 0);
        ctx.lineTo(col * cellSize + 0.5, height);
      }
      for (let row = 1; row < CONFIG.GRID_ROWS; row += 1) {
        ctx.moveTo(0, row * cellSize + 0.5);
        ctx.lineTo(width, row * cellSize + 0.5);
      }
      ctx.strokeStyle = CONFIG.COLORS.GRID_LINE;
      ctx.lineWidth = 1;
      ctx.stroke();
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

    function drawRoads(roads, now) {
      const tiles = describeTiles(roads, now);
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
      const { roads, activeTool } = store.getState();

      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      drawTerrain();
      drawRemovals(now);
      drawRoads(roads, now);
      drawHover(activeTool);

      pruneFinishedAnimations(now);
      if (placedAt.size > 0 || removals.length > 0) requestRender();
    }

    /** Starts grow-in / dust animations for whatever changed between two road sets. */
    function trackRoadChanges(roads, previousRoads) {
      if (prefersReducedMotion || roads === previousRoads) return;
      const now = performance.now();
      roads.forEach((key) => {
        if (!previousRoads.has(key)) placedAt.set(key, now);
      });
      const removed = [...previousRoads]
        .filter((key) => !roads.has(key))
        .map((key) => ({ ...parseKey(key), time: now }));
      removed.forEach(({ col, row }) => placedAt.delete(cellKey(col, row)));
      removals = [...removals, ...removed];
    }

    store.subscribe((state, previous) => {
      trackRoadChanges(state.roads, previous.roads);
      requestRender();
    });

    return {
      resize,
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
        col: Math.floor(((event.clientX - bounds.left) / bounds.width) * CONFIG.GRID_COLUMNS),
        row: Math.floor(((event.clientY - bounds.top) / bounds.height) * CONFIG.GRID_ROWS),
      };
    }

    function endStroke(event) {
      if (!stroke || event.pointerId !== stroke.pointerId) return;
      stroke = null;
      const cell = cellFromEvent(event);
      onHoverChange(event.type === 'pointerup' && isInBounds(cell) ? cell : null, null);
    }

    canvas.addEventListener('pointerdown', (event) => {
      if (stroke || (event.button !== PRIMARY_BUTTON && event.button !== SECONDARY_BUTTON)) return;
      event.preventDefault();
      const cell = clampCell(cellFromEvent(event));
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
        onHoverChange(isInBounds(rawCell) ? rawCell : null, null);
        return;
      }
      if (event.pointerId !== stroke.pointerId) return;
      const cell = clampCell(rawCell);
      if (cell.col === stroke.lastCell.col && cell.row === stroke.lastCell.row) return;
      store.update(actions.applyTool(stroke.tool, cellsBetween(stroke.lastCell, cell)));
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

  // ------------------------------------------------------------- Interface

  function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing page element: #' + id);
    return element;
  }

  function attachClearMapControl(store) {
    const clearButton = requireElement('clear-map');
    const dialog = requireElement('clear-dialog');
    const dialogText = requireElement('clear-dialog-text');
    const canUseDialog = typeof dialog.showModal === 'function';

    clearButton.addEventListener('click', () => {
      const count = store.getState().roads.size;
      if (count === 0) return;
      const message =
        (count === 1 ? 'The 1 road segment' : 'All ' + count + ' road segments') +
        " will be removed. This can't be undone.";
      if (!canUseDialog) {
        if (window.confirm('Clear the whole map? ' + message)) store.update(actions.clearMap());
        return;
      }
      dialogText.textContent = message;
      dialog.showModal();
    });

    // Only the confirm button clears; Escape and "Keep building" just close the dialog.
    // Handled on submit (not the later, asynchronous `close` event) so the map is
    // already empty by the time the player can touch it again.
    dialog.addEventListener('submit', (event) => {
      if (event.submitter && event.submitter.value === 'confirm') store.update(actions.clearMap());
    });

    return { clearButton, isDialogOpen: () => Boolean(dialog.open) };
  }

  function attachInterface(store, canvas) {
    const toolButtons = [...document.querySelectorAll('[data-tool]')].filter((el) => el.tagName === 'BUTTON');
    const segmentCount = requireElement('segment-count');
    const statusHint = requireElement('status-hint');
    const statusCell = requireElement('status-cell');
    const { clearButton, isDialogOpen } = attachClearMapControl(store);

    const TOOL_SHORTCUTS = Object.freeze({ r: TOOLS.ROAD, b: TOOLS.BULLDOZER });

    toolButtons.forEach((button) => {
      button.addEventListener('click', () => store.update(actions.selectTool(button.dataset.tool)));
    });

    window.addEventListener('keydown', (event) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isDialogOpen()) return;
      const tool = TOOL_SHORTCUTS[event.key.toLowerCase()];
      if (tool) store.update(actions.selectTool(tool));
    });

    function renderTool(activeTool) {
      toolButtons.forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.tool === activeTool));
      });
      canvas.dataset.tool = activeTool;
      statusHint.textContent = STATUS_HINTS[activeTool];
    }

    function renderSegmentCount(count, shouldAnimate) {
      segmentCount.textContent = String(count);
      clearButton.disabled = count === 0;
      if (!shouldAnimate) return;
      segmentCount.classList.remove('is-bumped');
      void segmentCount.offsetWidth; // restart the CSS animation
      segmentCount.classList.add('is-bumped');
    }

    store.subscribe((state, previous) => {
      if (state.activeTool !== previous.activeTool) renderTool(state.activeTool);
      if (state.roads.size !== previous.roads.size) renderSegmentCount(state.roads.size, true);
    });

    const initial = store.getState();
    renderTool(initial.activeTool);
    renderSegmentCount(initial.roads.size, false);

    return {
      showCursorCell(cell) {
        statusCell.textContent = cell ? 'Tile ' + (cell.col + 1) + ', ' + (cell.row + 1) : '';
      },
    };
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

  function startGame() {
    const canvas = requireElement('game-canvas');
    const viewport = requireElement('viewport');
    const store = createStore({ roads: new Set(), activeTool: TOOLS.ROAD });

    const renderer = createRenderer(canvas, viewport, store);
    const ui = attachInterface(store, canvas);
    attachInput(canvas, store, (cell, toolOverride) => {
      renderer.setHover(cell, toolOverride);
      ui.showCursorCell(cell);
    });

    watchViewportSize(viewport, renderer.resize);
    renderer.resize();

    // Read-only window into the game for debugging from the browser console.
    window.roadGameBuilder = Object.freeze({ getState: store.getState });
  }

  try {
    startGame();
  } catch (error) {
    showFatalError(error);
  }
})();
