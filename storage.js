/*
 * Road Game Builder — saving and loading.
 *
 * The game is kept in the browser's localStorage, so it survives a reload on
 * the same browser. cloud.js sends the same snapshot to the database. A save
 * is treated as untrusted input wherever it comes from: anything that does
 * not look right is dropped when it is read.
 */
(function () {
  'use strict';

  const SAVE_KEY = 'road-game-builder-save-v1';
  const CELL_KEY_PATTERN = /^\d{1,3},\d{1,3}$/;

  /** The game as plain JSON-ready data, stamped with the time it was taken. */
  function serializeGame(state) {
    return {
      roads: [...state.roads],
      houses: [...state.houses],
      shops: [...state.shops],
      parks: [...state.parks],
      junctions: [...state.junctions],
      city: state.city,
      savedAt: Date.now(),
    };
  }

  /**
   * Turns saved data back into a map and city, or returns null if it is unusable.
   * `isValidCell(key)` says whether a cell key lies on the map, `junctionTypes`
   * lists the feature types that exist, `defaultCity` supplies any city value
   * the save is missing and `clampTax` keeps the tax rate in range.
   */
  function parseSave(saved, { isValidCell, junctionTypes, defaultCity, clampTax }) {
    if (!saved || typeof saved !== 'object') return null;
    const cells = (list) =>
      (Array.isArray(list) ? list : []).filter(
        (key) => typeof key === 'string' && CELL_KEY_PATTERN.test(key) && isValidCell(key)
      );
    // A tile holds one thing: if a save disagrees, the kind listed first wins.
    const taken = new Set();
    const claim = (list) => {
      const keys = cells(list).filter((key) => !taken.has(key));
      keys.forEach((key) => taken.add(key));
      return new Set(keys);
    };
    const roads = claim(saved.roads);
    const houses = claim(saved.houses);
    const shops = claim(saved.shops);
    const parks = claim(saved.parks);
    const junctions = new Map(
      (Array.isArray(saved.junctions) ? saved.junctions : []).filter(
        (entry) => Array.isArray(entry) && roads.has(entry[0]) && junctionTypes.includes(entry[1])
      )
    );

    const savedCity = saved.city && typeof saved.city === 'object' ? saved.city : {};
    const number = (name) => (Number.isFinite(savedCity[name]) ? savedCity[name] : defaultCity[name]);
    const city = {
      money: number('money'),
      taxRate: clampTax(number('taxRate')),
      happiness: Math.min(Math.max(number('happiness'), 0), 100),
      peakPopulation: Math.max(0, number('peakPopulation')),
      day: Math.max(0, number('day')),
    };
    const savedAt = Number.isFinite(saved.savedAt) ? saved.savedAt : 0;
    return { roads, houses, shops, parks, junctions, city, savedAt };
  }

  function saveGame(state) {
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(serializeGame(state)));
      return true;
    } catch (error) {
      // Private windows and full storage both end up here; the game simply plays on unsaved.
      console.warn('Could not save the game:', error);
      return false;
    }
  }

  /** Reads the save kept in this browser, or returns null if there is no usable one. */
  function loadGame(options) {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      return raw ? parseSave(JSON.parse(raw), options) : null;
    } catch (error) {
      console.warn('Could not load the saved game, starting a new one:', error);
      return null;
    }
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, { serializeGame, parseSave, saveGame, loadGame });
})();
