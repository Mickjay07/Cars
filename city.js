/*
 * Road Game Builder — the city: money, residents, taxes, mood and goals.
 *
 * Everything here is a pure function of the game state, except createCity(),
 * which only keeps the stopwatch that decides when the next "day" is due.
 * One day passes per second of game time.
 */
(function () {
  'use strict';

  const CITY = Object.freeze({
    SECONDS_PER_DAY: 1,
    RESIDENTS_PER_HOUSE: 4,
    JOBS_PER_SHOP: 12,
    WORKING_SHARE: 0.5, // share of residents who need a job

    // Money. A tile's price is charged when it is built; upkeep and taxes are per day.
    PRICES: Object.freeze({ road: 10, shop: 150, park: 80, signal: 100, roundabout: 200, bridge: 500, toll: 250 }),
    DEMOLITION_FEE: 5,
    WATER_ROAD_FACTOR: 6, // a road across water is a causeway and costs this many times more
    ROAD_UPKEEP: 0.2,
    SHOP_UPKEEP: 1,
    PARK_UPKEEP: 0.5,
    TOLL_FEE: 2, // paid by every car that drives through a gate
    TAX_PER_RESIDENT_PER_POINT: 0.05, // daily income per resident for each 1% of tax

    // Taxes and mood. Happiness runs 0–100 and drifts towards a target each day.
    MIN_TAX: 0,
    MAX_TAX: 20,
    STARTING_TAX: 8,
    NEUTRAL_TAX: 8, // above this people grumble, below it they are pleased
    BASE_HAPPINESS: 75,
    HAPPINESS_PER_TAX_POINT: 5,
    CONGESTION_PENALTY: 30, // at most, when every car is stuck waiting
    UNEMPLOYMENT_PENALTY: 20, // at most, when nobody can find work
    PARK_BONUS: 15, // at most, once there is a park for every few houses
    HOUSES_PER_PARK: 4,
    TOLL_PENALTY: 2, // per gate
    MAX_TOLL_PENALTY: 10,
    HAPPINESS_STEP: 2, // largest change in one day

    // Moving in and out.
    GROW_FROM_HAPPINESS: 50,
    LEAVE_BELOW_HAPPINESS: 35,
    BASE_GROW_CHANCE: 0.15, // per day
    EXTRA_GROW_CHANCE: 0.6,
    BASE_LEAVE_CHANCE: 0.05,
    EXTRA_LEAVE_CHANCE: 0.25,
  });

  /** Reached by peak population. `unlocks` is a tool id from game.js, or null for a cash-only goal. */
  const GOALS = Object.freeze([
    Object.freeze({ population: 20, unlocks: 'signal', label: 'Traffic lights', reward: 300 }),
    Object.freeze({ population: 60, unlocks: 'roundabout', label: 'Roundabouts', reward: 500 }),
    Object.freeze({ population: 120, unlocks: 'bridge', label: 'Bridges', reward: 800 }),
    Object.freeze({ population: 250, unlocks: null, label: 'A proper town', reward: 1500 }),
  ]);

  const NEIGHBOUR_OFFSETS = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  /** A brand-new city's books. The starting money depends on the world's difficulty. */
  function initialCity(world) {
    return { money: window.RoadGameModules.difficultyOf(world).money, taxRate: CITY.STARTING_TAX, happiness: CITY.BASE_HAPPINESS, peakPopulation: 0, day: 0 };
  }

  const populationOf = (state) => state.houses.size * CITY.RESIDENTS_PER_HOUSE;
  const jobsOf = (state) => state.shops.size * CITY.JOBS_PER_SHOP;

  /** 0 when everyone who wants a job has one, 1 when nobody does. */
  function unemploymentOf(state) {
    const workers = populationOf(state) * CITY.WORKING_SHARE;
    return workers === 0 ? 0 : clamp(1 - jobsOf(state) / workers, 0, 1);
  }

  function dailyBudget(state) {
    const income = populationOf(state) * state.city.taxRate * CITY.TAX_PER_RESIDENT_PER_POINT;
    const upkeep =
      state.roads.size * CITY.ROAD_UPKEEP + state.shops.size * CITY.SHOP_UPKEEP + state.parks.size * CITY.PARK_UPKEEP;
    return { income, upkeep, balance: income - upkeep };
  }

  function isToolUnlocked(tool, city) {
    const goal = GOALS.find((candidate) => candidate.unlocks === tool);
    return !goal || city.peakPopulation >= goal.population;
  }

  const nextGoal = (city) => GOALS.find((goal) => city.peakPopulation < goal.population) || null;
  const priceOfTool = (tool) => CITY.PRICES[tool] || 0;

  function junctionPrice(type) {
    return type.startsWith('bridge') ? CITY.PRICES.bridge : CITY.PRICES[type] || 0;
  }

  /** What it costs to turn the map in `before` into the map in `after`. */
  function costOfChange(before, after) {
    const added = (now, was) => [...now].filter((key) => !was.has(key)).length;
    const newJunctions = [...after.junctions].filter(([key]) => !before.junctions.has(key));
    const demolished =
      added(before.roads, after.roads) + added(before.houses, after.houses) +
      added(before.shops, after.shops) + added(before.parks, after.parks);
    return (
      added(after.roads, before.roads) * CITY.PRICES.road +
      [...after.roads].filter((key) => !before.roads.has(key) && after.water.has(key)).length *
        CITY.PRICES.road * (CITY.WATER_ROAD_FACTOR - 1) +
      added(after.shops, before.shops) * CITY.PRICES.shop +
      added(after.parks, before.parks) * CITY.PRICES.park +
      newJunctions.reduce((sum, [, type]) => sum + junctionPrice(type), 0) +
      demolished * CITY.DEMOLITION_FEE
    );
  }

  /** Mood gained from parks: full bonus once there is one park for every few houses. */
  function parkBonusOf(state) {
    const parksWanted = Math.max(1, state.houses.size / CITY.HOUSES_PER_PARK);
    return CITY.PARK_BONUS * clamp(state.parks.size / parksWanted, 0, 1);
  }

  const tollCountOf = (state) => [...state.junctions.values()].filter((type) => type === 'toll').length;

  /** Everything that upsets residents is scaled by the difficulty; what pleases them is not. */
  function happinessTarget(state, congestion) {
    const { sensitivity } = window.RoadGameModules.difficultyOf(state.world);
    const taxEffect = (CITY.NEUTRAL_TAX - state.city.taxRate) * CITY.HAPPINESS_PER_TAX_POINT;
    const grievances =
      Math.max(0, -taxEffect) +
      clamp(congestion, 0, 1) * CITY.CONGESTION_PENALTY +
      unemploymentOf(state) * CITY.UNEMPLOYMENT_PENALTY +
      Math.min(CITY.MAX_TOLL_PENALTY, tollCountOf(state) * CITY.TOLL_PENALTY);
    const comforts = Math.max(0, taxEffect) + parkBonusOf(state);
    return clamp(CITY.BASE_HAPPINESS + comforts - grievances * sensitivity, 0, 100);
  }

  function createCity({ cellKey, random = Math.random }) {
    let secondsIntoDay = 0;

    const parseKey = (key) => key.split(',').map(Number);
    const pickRandom = (items) => items[Math.floor(random() * items.length)];

    /** Empty tiles next to a road — the only places a family will build. */
    function freeRoadsideTiles(state) {
      const isFree = (key) => ['roads', 'houses', 'shops', 'parks', 'water'].every((kind) => !state[kind].has(key));
      const candidates = [...state.roads].flatMap((roadKey) => {
        const [col, row] = parseKey(roadKey);
        return NEIGHBOUR_OFFSETS.map(([dx, dy]) => [col + dx, row + dy])
          .filter(([c, r]) => c >= 0 && c < state.world.columns && r >= 0 && r < state.world.rows)
          .map(([c, r]) => cellKey(c, r))
          .filter(isFree);
      });
      return [...new Set(candidates)];
    }

    /** One family moves in if people are content, or one moves out if they are fed up. */
    function settleHouses(state, happiness) {
      if (happiness >= CITY.GROW_FROM_HAPPINESS) {
        const eagerness = (happiness - CITY.GROW_FROM_HAPPINESS) / (100 - CITY.GROW_FROM_HAPPINESS);
        const plots = freeRoadsideTiles(state);
        if (plots.length === 0 || random() >= CITY.BASE_GROW_CHANCE + CITY.EXTRA_GROW_CHANCE * eagerness) return state.houses;
        return new Set([...state.houses, pickRandom(plots)]);
      }
      if (happiness < CITY.LEAVE_BELOW_HAPPINESS && state.houses.size > 0) {
        const anger = (CITY.LEAVE_BELOW_HAPPINESS - happiness) / CITY.LEAVE_BELOW_HAPPINESS;
        if (random() >= CITY.BASE_LEAVE_CHANCE + CITY.EXTRA_LEAVE_CHANCE * anger) return state.houses;
        const leaving = pickRandom([...state.houses]);
        return new Set([...state.houses].filter((key) => key !== leaving));
      }
      return state.houses;
    }

    function advanceOneDay(state, congestion) {
      const { city } = state;
      const drift = clamp(happinessTarget(state, congestion) - city.happiness, -CITY.HAPPINESS_STEP, CITY.HAPPINESS_STEP);
      const happiness = city.happiness + drift;
      const houses = settleHouses(state, happiness);

      const peakPopulation = Math.max(city.peakPopulation, houses.size * CITY.RESIDENTS_PER_HOUSE);
      const rewards = GOALS.filter((goal) => goal.population > city.peakPopulation && goal.population <= peakPopulation)
        .reduce((sum, goal) => sum + goal.reward, 0);
      const money = city.money + dailyBudget(state).balance + rewards;
      return { ...state, houses, city: { ...city, money, happiness, peakPopulation, day: city.day + 1 } };
    }

    return {
      /** Returns the state after any days that have come due, or the same state if none has. */
      tick(deltaSeconds, state, congestion) {
        secondsIntoDay += deltaSeconds;
        if (secondsIntoDay < CITY.SECONDS_PER_DAY) return state;
        secondsIntoDay -= CITY.SECONDS_PER_DAY;
        return advanceOneDay(state, congestion);
      },
    };
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, {
    CITY,
    GOALS,
    createCity,
    initialCity,
    populationOf,
    jobsOf,
    dailyBudget,
    isToolUnlocked,
    nextGoal,
    priceOfTool,
    costOfChange,
    tollCountOf,
  });
})();
