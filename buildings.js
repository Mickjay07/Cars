/*
 * Road Game Builder — buildings.
 *
 * A building is a house or a shop, each occupying one tile. This file only
 * knows how to draw them; where houses stand is part of the game state in game.js.
 */
(function () {
  'use strict';

  const HOUSE = Object.freeze({
    // All sizes are fractions of a tile.
    SIZE: 0.62,
    LOT_INSET: 0.06,
    DRIVEWAY_WIDTH: 0.2,
    SHADOW_OFFSET: 0.05,

    LOT_COLOR: 'rgba(255, 255, 255, 0.10)',
    DRIVEWAY_COLOR: '#b7b2a3',
    SHADOW_COLOR: 'rgba(20, 40, 20, 0.28)',
    RIDGE_COLOR: 'rgba(0, 0, 0, 0.25)',
    ROOFS: Object.freeze([
      Object.freeze({ light: '#cf6f4f', dark: '#b55a3d' }), // terracotta
      Object.freeze({ light: '#6f8fae', dark: '#58789a' }), // slate blue
      Object.freeze({ light: '#d9b77a', dark: '#c29f62' }), // sand
      Object.freeze({ light: '#a9584f', dark: '#8f463e' }), // brick red
      Object.freeze({ light: '#8a8f96', dark: '#73787f' }), // grey
    ]),
  });

  /** Stable pseudo-random number per tile, so a house always looks the same. */
  function tileHash(col, row) {
    return ((col * 73856093) ^ (row * 19349663)) >>> 0;
  }

  function drawDriveway(ctx, centerX, centerY, cellSize, direction) {
    const half = (HOUSE.DRIVEWAY_WIDTH * cellSize) / 2;
    const reach = cellSize / 2;
    ctx.fillStyle = HOUSE.DRIVEWAY_COLOR;
    ctx.fillRect(
      centerX + Math.min(0, direction.x * reach) - (direction.x === 0 ? half : 0),
      centerY + Math.min(0, direction.y * reach) - (direction.y === 0 ? half : 0),
      direction.x === 0 ? half * 2 : reach,
      direction.y === 0 ? half * 2 : reach
    );
  }

  /**
   * Draws one house, seen from above, on the tile at (col, row).
   * `scale` (0..1) shrinks it for the placement animation; `drivewayDirection`
   * is a unit vector towards a neighbouring road, or null if there is none.
   */
  function drawHouse(ctx, { col, row, cellSize, scale, drivewayDirection }) {
    const hash = tileHash(col, row);
    const roof = HOUSE.ROOFS[hash % HOUSE.ROOFS.length];
    const isRidgeHorizontal = ((hash >> 4) & 1) === 1;

    const centerX = (col + 0.5) * cellSize;
    const centerY = (row + 0.5) * cellSize;
    const lotInset = HOUSE.LOT_INSET * cellSize;
    const size = HOUSE.SIZE * cellSize * scale;
    const left = centerX - size / 2;
    const top = centerY - size / 2;
    const shadow = HOUSE.SHADOW_OFFSET * cellSize;

    ctx.fillStyle = HOUSE.LOT_COLOR;
    ctx.fillRect(col * cellSize + lotInset, row * cellSize + lotInset, cellSize - lotInset * 2, cellSize - lotInset * 2);
    if (drivewayDirection) drawDriveway(ctx, centerX, centerY, cellSize, drivewayDirection);

    ctx.fillStyle = HOUSE.SHADOW_COLOR;
    ctx.fillRect(left + shadow, top + shadow, size, size);

    // Two roof slopes meeting at the ridge, one lit and one in shade.
    ctx.fillStyle = roof.light;
    ctx.fillRect(left, top, size, size);
    ctx.fillStyle = roof.dark;
    if (isRidgeHorizontal) {
      ctx.fillRect(left, centerY, size, size / 2);
    } else {
      ctx.fillRect(centerX, top, size / 2, size);
    }

    ctx.beginPath();
    if (isRidgeHorizontal) {
      ctx.moveTo(left, centerY);
      ctx.lineTo(left + size, centerY);
    } else {
      ctx.moveTo(centerX, top);
      ctx.lineTo(centerX, top + size);
    }
    ctx.strokeStyle = HOUSE.RIDGE_COLOR;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const SHOP = Object.freeze({
    SIZE: 0.78,
    WALL_COLOR: '#dfe3e6',
    ROOF_COLOR: '#9fb4c4',
    TRIM_COLOR: '#4f8fc0',
    VENT_COLOR: '#6d7f8c',
  });

  /** Draws one shop: a bigger, flat-roofed block with a coloured front strip. Same options as drawHouse. */
  function drawShop(ctx, { col, row, cellSize, scale, drivewayDirection }) {
    const centerX = (col + 0.5) * cellSize;
    const centerY = (row + 0.5) * cellSize;
    const size = SHOP.SIZE * cellSize * scale;
    const left = centerX - size / 2;
    const top = centerY - size / 2;
    const shadow = HOUSE.SHADOW_OFFSET * cellSize;
    const wall = Math.max(1, size * 0.1);

    if (drivewayDirection) drawDriveway(ctx, centerX, centerY, cellSize, drivewayDirection);
    ctx.fillStyle = HOUSE.SHADOW_COLOR;
    ctx.fillRect(left + shadow, top + shadow, size, size);
    ctx.fillStyle = SHOP.WALL_COLOR;
    ctx.fillRect(left, top, size, size);
    ctx.fillStyle = SHOP.ROOF_COLOR;
    ctx.fillRect(left + wall, top + wall, size - wall * 2, size - wall * 2);
    ctx.fillStyle = SHOP.TRIM_COLOR;
    ctx.fillRect(left, top + size - wall * 1.6, size, wall * 1.6);
    ctx.fillStyle = SHOP.VENT_COLOR;
    ctx.fillRect(left + size * 0.22, top + size * 0.22, size * 0.2, size * 0.2);
  }

  const PARK = Object.freeze({
    INSET: 0.07,
    LAWN_COLOR: '#6ea65b',
    PATH_COLOR: '#cdbf95',
    TREE_COLOR: '#3f7d43',
    TREE_HIGHLIGHT_COLOR: '#5a9a52',
    TREE_RADIUS: 0.15,
    // Tree positions as fractions of a tile, measured from its centre.
    TREES: Object.freeze([Object.freeze([-0.22, -0.2]), Object.freeze([0.2, -0.12]), Object.freeze([-0.05, 0.22])]),
  });

  /** Draws one park: a lawn with a path across it and a few trees. */
  function drawPark(ctx, { col, row, cellSize, scale }) {
    const centerX = (col + 0.5) * cellSize;
    const centerY = (row + 0.5) * cellSize;
    const size = cellSize * (1 - PARK.INSET * 2) * scale;
    ctx.fillStyle = PARK.LAWN_COLOR;
    ctx.fillRect(centerX - size / 2, centerY - size / 2, size, size);
    ctx.fillStyle = PARK.PATH_COLOR;
    ctx.fillRect(centerX - size / 2, centerY + size * 0.02, size, Math.max(1, size * 0.09));
    PARK.TREES.forEach(([dx, dy]) => {
      const x = centerX + dx * cellSize * scale;
      const y = centerY + dy * cellSize * scale;
      const radius = PARK.TREE_RADIUS * cellSize * scale;
      ctx.fillStyle = PARK.TREE_COLOR;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = PARK.TREE_HIGHLIGHT_COLOR;
      ctx.beginPath();
      ctx.arc(x - radius * 0.25, y - radius * 0.25, radius * 0.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, { drawHouse, drawShop, drawPark });
})();
