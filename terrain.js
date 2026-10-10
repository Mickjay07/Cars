/*
 * Road Game Builder — the land itself: grass with uneven patches, a faint
 * building grid and the odd tree on tiles nobody has built on.
 *
 * Everything is derived from the tile position, so the land looks the same
 * every time without being stored anywhere.
 */
(function () {
  'use strict';

  const LAND = Object.freeze({
    GRASS_COLOR: '#8fc27a',
    LIGHT_PATCH_COLOR: 'rgba(255, 255, 220, 0.035)',
    DARK_PATCH_COLOR: 'rgba(30, 70, 30, 0.03)',
    GRID_COLOR: 'rgba(30, 70, 30, 0.07)',
    PATCH_TILES: 3, // patches of grass are this many tiles across
    TREE_CHANCE_PERCENT: 6,
    TREE_RADIUS: 0.2, // fraction of a tile
    TREE_SHADOW_COLOR: 'rgba(25, 60, 30, 0.25)',
    TREE_COLOR: '#4f9150',
    TREE_HIGHLIGHT_COLOR: '#6bab62',
    WATER_COLOR: '#6db4dc',
    WAVE_COLOR: 'rgba(255, 255, 255, 0.28)',
    SAND_COLOR: 'rgba(240, 222, 160, 0.45)',
  });

  /** Stable pseudo-random number for a pair of coordinates. */
  function hashOf(x, y) {
    let h = (x * 374761393 + y * 668265263) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  function drawPatches(ctx, columns, rows, cellSize) {
    const size = LAND.PATCH_TILES;
    for (let col = 0; col < columns; col += size) {
      for (let row = 0; row < rows; row += size) {
        const roll = hashOf(col, row) % 5;
        if (roll > 1) continue;
        ctx.fillStyle = roll === 0 ? LAND.LIGHT_PATCH_COLOR : LAND.DARK_PATCH_COLOR;
        const width = Math.min(size, columns - col) * cellSize;
        const height = Math.min(size, rows - row) * cellSize;
        ctx.fillRect(col * cellSize, row * cellSize, width, height);
      }
    }
  }

  function drawGrid(ctx, columns, rows, cellSize) {
    ctx.beginPath();
    for (let col = 1; col < columns; col += 1) {
      ctx.moveTo(col * cellSize + 0.5, 0);
      ctx.lineTo(col * cellSize + 0.5, rows * cellSize);
    }
    for (let row = 1; row < rows; row += 1) {
      ctx.moveTo(0, row * cellSize + 0.5);
      ctx.lineTo(columns * cellSize, row * cellSize + 0.5);
    }
    ctx.strokeStyle = LAND.GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawTree(ctx, col, row, cellSize, seed) {
    // Nudge each tree off-centre so they do not line up with the grid.
    const x = (col + 0.3 + ((seed >>> 8) % 40) / 100) * cellSize;
    const y = (row + 0.3 + ((seed >>> 16) % 40) / 100) * cellSize;
    const radius = LAND.TREE_RADIUS * cellSize * (0.8 + ((seed >>> 4) % 5) / 10);
    const disc = (cx, cy, r, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    };
    disc(x + radius * 0.35, y + radius * 0.4, radius, LAND.TREE_SHADOW_COLOR);
    disc(x, y, radius, LAND.TREE_COLOR);
    disc(x - radius * 0.25, y - radius * 0.3, radius * 0.5, LAND.TREE_HIGHLIGHT_COLOR);
  }

  function drawWaterTile(ctx, col, row, cellSize, seed) {
    ctx.fillStyle = LAND.WATER_COLOR;
    ctx.fillRect(col * cellSize, row * cellSize, cellSize + 0.5, cellSize + 0.5);
    if (seed % 3 !== 0) return;
    // A short ripple on some tiles, so the water is not one flat sheet.
    const x = (col + 0.2 + ((seed >>> 8) % 30) / 100) * cellSize;
    const y = (row + 0.3 + ((seed >>> 16) % 40) / 100) * cellSize;
    ctx.fillStyle = LAND.WAVE_COLOR;
    ctx.fillRect(x, y, cellSize * 0.3, Math.max(1, cellSize * 0.06));
  }

  /**
   * Paints the whole map's ground. `isWater(col, row)` marks sea, river and lake tiles;
   * `isBuiltOn(col, row)` hides trees under anything the player built.
   */
  function drawTerrain(ctx, { columns, rows, cellSize, isBuiltOn, isWater }) {
    ctx.fillStyle = LAND.GRASS_COLOR;
    ctx.fillRect(0, 0, columns * cellSize, rows * cellSize);
    drawPatches(ctx, columns, rows, cellSize);
    drawGrid(ctx, columns, rows, cellSize);
    const isShore = (col, row) =>
      isWater(col - 1, row) || isWater(col + 1, row) || isWater(col, row - 1) || isWater(col, row + 1);
    for (let col = 0; col < columns; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        const seed = hashOf(col + 1000, row + 1000);
        if (isWater(col, row)) {
          drawWaterTile(ctx, col, row, cellSize, seed);
        } else if (isShore(col, row)) {
          ctx.fillStyle = LAND.SAND_COLOR;
          ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        } else if (seed % 100 < LAND.TREE_CHANCE_PERCENT && !isBuiltOn(col, row)) {
          drawTree(ctx, col, row, cellSize, seed);
        }
      }
    }
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, { drawTerrain });
})();
