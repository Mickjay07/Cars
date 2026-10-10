/*
 * Road Game Builder — worlds: the choices made when a city is founded
 * (difficulty, map size, landscape, lakes) and the land generated from them.
 *
 * A world is a small plain object. Its water is not stored anywhere: it is
 * regenerated from the world's seed, so the same world always has the same
 * coastline.
 */
(function () {
  'use strict';

  const SIZES = Object.freeze({
    small: Object.freeze({ label: 'Small', columns: 28, rows: 18 }),
    medium: Object.freeze({ label: 'Medium', columns: 40, rows: 24 }),
    large: Object.freeze({ label: 'Large', columns: 56, rows: 34 }),
  });

  const SHAPES = Object.freeze({
    plain: Object.freeze({ label: 'Open plain' }),
    island: Object.freeze({ label: 'Island' }),
    coast: Object.freeze({ label: 'Coast' }),
    river: Object.freeze({ label: 'River valley' }),
  });

  /** `sensitivity` scales everything that upsets residents: taxes, jams, no jobs, toll gates. */
  const DIFFICULTIES = Object.freeze({
    easy: Object.freeze({ label: 'Easy', money: 3000, sensitivity: 0.7, note: '$3,000 to start. Residents are forgiving.' }),
    normal: Object.freeze({ label: 'Normal', money: 2000, sensitivity: 1, note: '$2,000 to start.' }),
    hard: Object.freeze({ label: 'Hard', money: 1200, sensitivity: 1.4, note: '$1,200 to start. Residents take offence quickly.' }),
  });

  const DEFAULTS = Object.freeze({ size: 'medium', shape: 'plain', difficulty: 'normal' });
  const TILES_PER_LAKE = 320;
  const MAX_SEED = 2147483647;

  const has = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

  /** A valid world built from possibly missing or damaged saved data. Saves from before worlds existed get the defaults. */
  function sanitizeWorld(saved) {
    const source = saved && typeof saved === 'object' ? saved : {};
    const size = has(SIZES, source.size) ? source.size : DEFAULTS.size;
    return {
      size,
      columns: SIZES[size].columns,
      rows: SIZES[size].rows,
      shape: has(SHAPES, source.shape) ? source.shape : DEFAULTS.shape,
      lakes: source.lakes === true,
      difficulty: has(DIFFICULTIES, source.difficulty) ? source.difficulty : DEFAULTS.difficulty,
      seed: Number.isInteger(source.seed) && source.seed > 0 ? source.seed : 1,
    };
  }

  /** A new world for the given choices, with a fresh random seed. */
  function createWorld(choices) {
    return sanitizeWorld({ ...choices, seed: 1 + Math.floor(Math.random() * (MAX_SEED - 1)) });
  }

  const difficultyOf = (world) => DIFFICULTIES[sanitizeWorld(world).difficulty];

  function describeWorld(world) {
    const { size, shape, lakes, difficulty } = sanitizeWorld(world);
    return SIZES[size].label + ' ' + SHAPES[shape].label.toLowerCase() + (lakes ? ' with lakes' : '') + ' · ' + DIFFICULTIES[difficulty].label;
  }

  /** Repeatable random numbers in [0, 1) from a seed (the "mulberry32" generator). */
  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A smooth, repeating wiggle: a function of t in [0, 1] returning a value within ±amplitude. */
  function makeWobble(random, amplitude) {
    const waves = [0.6, 0.3, 0.1].map((weight, index) => ({ weight, turns: index + 1, phase: random() }));
    return (t) => amplitude * waves.reduce((sum, wave) => sum + wave.weight * Math.sin(Math.PI * 2 * (t * wave.turns + wave.phase)), 0);
  }

  // Each landscape returns a test: is the tile at (col, row) under water?
  const LANDSCAPES = Object.freeze({
    plain: () => () => false,

    island({ columns, rows }, random) {
      const wobble = makeWobble(random, 0.09);
      return (col, row) => {
        const x = ((col + 0.5) / columns) * 2 - 1;
        const y = ((row + 0.5) / rows) * 2 - 1;
        const bearing = Math.atan2(y, x) / (Math.PI * 2) + 0.5;
        return Math.hypot(x, y) > 0.86 + wobble(bearing);
      };
    },

    coast({ columns, rows }, random) {
      const side = Math.floor(random() * 4); // 0 top, 1 right, 2 bottom, 3 left
      const wobble = makeWobble(random, 0.05);
      const isSeaAcross = side % 2 === 0; // the sea runs along the top or bottom edge
      return (col, row) => {
        const along = isSeaAcross ? (col + 0.5) / columns : (row + 0.5) / rows;
        const span = isSeaAcross ? rows : columns;
        const position = isSeaAcross ? row + 0.5 : col + 0.5;
        const fromShore = side === 0 || side === 3 ? position : span - position;
        return fromShore < (0.2 + wobble(along)) * span;
      };
    },

    river({ columns, rows }, random) {
      const flowsDown = random() < 0.5;
      const wobble = makeWobble(random, 0.16);
      const halfWidth = 1.3 + random() * 0.6;
      return (col, row) => {
        const along = flowsDown ? (row + 0.5) / rows : (col + 0.5) / columns;
        const span = flowsDown ? columns : rows;
        const position = flowsDown ? col + 0.5 : row + 0.5;
        return Math.abs(position - (0.5 + wobble(along)) * span) < halfWidth;
      };
    },
  });

  function makeLakes({ columns, rows }, random) {
    const count = Math.max(1, Math.round((columns * rows) / TILES_PER_LAKE));
    return Array.from({ length: count }, () => ({
      x: random() * columns,
      y: random() * rows,
      radius: 1.4 + random() * 1.8,
    }));
  }

  /** The set of "col,row" keys of every water tile in a world. */
  function generateWater(world) {
    const safeWorld = sanitizeWorld(world);
    const random = seededRandom(safeWorld.seed);
    const isSea = LANDSCAPES[safeWorld.shape](safeWorld, random);
    const lakes = safeWorld.lakes ? makeLakes(safeWorld, random) : [];
    const isLake = (col, row) => lakes.some((lake) => Math.hypot(col + 0.5 - lake.x, row + 0.5 - lake.y) < lake.radius);

    const keys = [];
    for (let col = 0; col < safeWorld.columns; col += 1) {
      for (let row = 0; row < safeWorld.rows; row += 1) {
        if (isSea(col, row) || isLake(col, row)) keys.push(col + ',' + row);
      }
    }
    return new Set(keys);
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, {
    SIZES,
    SHAPES,
    DIFFICULTIES,
    sanitizeWorld,
    createWorld,
    describeWorld,
    difficultyOf,
    generateWater,
  });
})();
