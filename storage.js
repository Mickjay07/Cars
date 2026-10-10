/*
 * Road Game Builder — saving and loading.
 *
 * There are three save slots, kept in the browser's localStorage, so they
 * survive a reload on the same browser. cloud.js sends the same data to the
 * player's account. A save is treated as untrusted input wherever it comes
 * from: anything that does not look right is dropped when it is read.
 */
(function () {
  'use strict';

  const SLOTS = Object.freeze([1, 2, 3]);
  const SLOT_KEY_PREFIX = 'road-game-builder-slot-';
  const OWNERS_KEY = 'road-game-builder-slot-owners';
  const LEGACY_SAVE_KEY = 'road-game-builder-save-v1'; // the single save used before slots existed
  const CELL_KEY_PATTERN = /^\d{1,3},\d{1,3}$/;
  const SAVED_PARTS = Object.freeze(['roads', 'houses', 'shops', 'parks', 'junctions', 'city', 'world']);

  const isSlot = (slot) => SLOTS.includes(slot);

  function readJson(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn('Could not read ' + key + ':', error);
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      // Private windows and full storage both end up here; the game simply plays on unsaved.
      console.warn('Could not write ' + key + ':', error);
      return false;
    }
  }

  /** The game as plain JSON-ready data, stamped with the time it was taken. */
  function serializeGame(state) {
    return {
      world: state.world,
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
   * Turns saved data back into a world, map and city, or returns null if it is unusable.
   * `sanitizeWorld` repairs the world settings, `isValidCell(key, world)` says whether a
   * cell key lies on that world's map, `junctionTypes` lists the feature types that
   * exist, `defaultCity(world)` supplies any city value the save is missing and
   * `clampTax` keeps the tax rate in range.
   */
  function parseSave(saved, { sanitizeWorld, isValidCell, junctionTypes, defaultCity, clampTax }) {
    if (!saved || typeof saved !== 'object') return null;
    const world = sanitizeWorld(saved.world);
    const cells = (list) =>
      (Array.isArray(list) ? list : []).filter(
        (key) => typeof key === 'string' && CELL_KEY_PATTERN.test(key) && isValidCell(key, world)
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

    const fallback = defaultCity(world);
    const savedCity = saved.city && typeof saved.city === 'object' ? saved.city : {};
    const number = (name) => (Number.isFinite(savedCity[name]) ? savedCity[name] : fallback[name]);
    const city = {
      money: number('money'),
      taxRate: clampTax(number('taxRate')),
      happiness: Math.min(Math.max(number('happiness'), 0), 100),
      peakPopulation: Math.max(0, number('peakPopulation')),
      day: Math.max(0, number('day')),
    };
    const savedAt = Number.isFinite(saved.savedAt) ? saved.savedAt : 0;
    return { world, roads, houses, shops, parks, junctions, city, savedAt };
  }

  /** Moves the single save from older versions of the game into slot 1, once. */
  function adoptLegacySave() {
    const legacy = readJson(LEGACY_SAVE_KEY);
    if (!legacy) return;
    if (!readJson(SLOT_KEY_PREFIX + 1)) writeJson(SLOT_KEY_PREFIX + 1, legacy);
    try {
      window.localStorage.removeItem(LEGACY_SAVE_KEY);
    } catch (error) {
      console.warn('Could not remove the old save:', error);
    }
  }

  /** The saved data in a slot exactly as stored (not yet checked), or null if the slot is empty. */
  const readSlotRaw = (slot) => (isSlot(slot) ? readJson(SLOT_KEY_PREFIX + slot) : null);
  const writeSlotRaw = (slot, data) => isSlot(slot) && writeJson(SLOT_KEY_PREFIX + slot, data);
  const loadSlot = (slot, rules) => parseSave(readSlotRaw(slot), rules);
  const saveSlot = (slot, state) => writeSlotRaw(slot, serializeGame(state));

  /** Which account a slot's city belongs to (a user id), or null if it has never been tied to one. */
  const getSlotOwner = (slot) => (readJson(OWNERS_KEY) || {})[slot] || null;
  const setSlotOwner = (slot, userId) => writeJson(OWNERS_KEY, { ...(readJson(OWNERS_KEY) || {}), [slot]: userId });

  /** Saves the slot being played shortly after anything worth keeping changes, at most once per delay. */
  function startAutosave(store, delayMs) {
    let pendingSave = null;
    store.subscribe((state, previous) => {
      const isWorthSaving = state.slot !== null && SAVED_PARTS.some((part) => state[part] !== previous[part]);
      if (!isWorthSaving || pendingSave !== null) return;
      pendingSave = window.setTimeout(() => {
        pendingSave = null;
        const latest = store.getState();
        if (latest.slot !== null) saveSlot(latest.slot, latest);
      }, delayMs);
    });
  }

  adoptLegacySave();

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, {
    SLOTS,
    SAVED_PARTS,
    serializeGame,
    parseSave,
    readSlotRaw,
    writeSlotRaw,
    loadSlot,
    saveSlot,
    getSlotOwner,
    setSlotOwner,
    startAutosave,
  });
})();
