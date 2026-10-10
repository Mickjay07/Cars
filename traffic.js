/*
 * Road Game Builder — traffic.
 *
 * Cars make trips between houses and shops along the shortest route (or just
 * wander for a while if the town has no shops yet). Each one drives through a
 * tile along its right-hand lane.
 * They keep a gap behind the car in front, stop at red lights, give way when
 * entering a roundabout and drive straight across bridges. Plain
 * intersections still have no right-of-way rules.
 *
 * The module owns only the list of cars. It is told about the map every step
 * and never changes it.
 */
(function () {
  'use strict';

  const TRAFFIC = Object.freeze({
    MAX_CARS: 60,
    CARS_PER_HOUSE: 0.6, // cars on the road at once, per house that can reach a road
    WANDER_SECONDS: 30, // how long a car with nowhere to go drives around before it parks
    CONGESTION_SMOOTHING_SECONDS: 5,
    SPAWN_INTERVAL_SECONDS: 0.35,
    MIN_SPEED: 1.6, // tiles per second
    MAX_SPEED: 2.4,
    FADE_IN_SECONDS: 0.3,

    // All sizes are fractions of a tile.
    LANE_OFFSET: 0.15,
    CAR_LENGTH: 0.36,
    CAR_WIDTH: 0.18,
    U_TURN_DEPTH: 0.6,

    FOLLOW_GAP: 0.45, // minimum distance kept behind the car ahead
    STOP_LINE: 0.88, // how far through a tile a car waits before a junction it may not enter
    ROUNDABOUT_LANE_RADIUS: 0.3,
    ROUNDABOUT_BLEND: 0.2, // share of the trip spent steering onto and off the ring
    ROUNDABOUT_CLEAR_PROGRESS: 0.5, // a car this far round no longer holds up cars entering
    HEADING_SAMPLE: 0.02,
    TOLL_PACE: 0.35, // share of normal speed while passing a toll gate

    // Approximate length of each kind of path through a tile, so cars keep a steady speed.
    PATH_LENGTH: Object.freeze({ STRAIGHT: 1, RIGHT_TURN: 0.55, LEFT_TURN: 1.1, U_TURN: 1.3 }),

    BODY_COLORS: Object.freeze(['#ece8dc', '#d9534a', '#4a86c5', '#f0b93a', '#5aa7a0', '#e88a3c']),
    WINDSHIELD_COLOR: 'rgba(20, 28, 34, 0.55)',
  });

  // Index order matters: +1 is a right turn, +2 is the opposite direction.
  const DIRECTIONS = Object.freeze([
    Object.freeze({ x: 0, y: -1 }), // north
    Object.freeze({ x: 1, y: 0 }), // east
    Object.freeze({ x: 0, y: 1 }), // south
    Object.freeze({ x: -1, y: 0 }), // west
  ]);

  const oppositeOf = (direction) => (direction + 2) % 4;
  /** Unit vector pointing to the right of a direction of travel (screen y points down). */
  const rightOf = (vector) => ({ x: -vector.y, y: vector.x });

  /** Angle travelled around a roundabout (anticlockwise on screen), from entry to exit. */
  function roundaboutSweep(start, end) {
    const fullTurn = Math.PI * 2;
    const sweep = (((Math.atan2(start.y, start.x) - Math.atan2(end.y, end.x)) % fullTurn) + fullTurn) % fullTurn;
    return sweep < 0.01 ? fullTurn : sweep;
  }

  function pathLength(car) {
    if (car.isOnRoundabout) {
      const { start, end } = pathThroughTile(car);
      return TRAFFIC.ROUNDABOUT_LANE_RADIUS * roundaboutSweep(start, end) + 0.5;
    }
    if (car.exitDirection === car.entryDirection) return TRAFFIC.PATH_LENGTH.STRAIGHT;
    if (car.exitDirection === oppositeOf(car.entryDirection)) return TRAFFIC.PATH_LENGTH.U_TURN;
    const isRightTurn = car.exitDirection === (car.entryDirection + 1) % 4;
    return isRightTurn ? TRAFFIC.PATH_LENGTH.RIGHT_TURN : TRAFFIC.PATH_LENGTH.LEFT_TURN;
  }

  /**
   * The curve a car follows through its tile, as three control points relative
   * to the tile centre: in at one edge, out at another, always keeping right.
   */
  function pathThroughTile(car) {
    const entry = DIRECTIONS[car.entryDirection];
    const exit = DIRECTIONS[car.exitDirection];
    const entryRight = rightOf(entry);
    const exitRight = rightOf(exit);
    const lane = TRAFFIC.LANE_OFFSET;

    const start = { x: -entry.x * 0.5 + entryRight.x * lane, y: -entry.y * 0.5 + entryRight.y * lane };
    const end = { x: exit.x * 0.5 + exitRight.x * lane, y: exit.y * 0.5 + exitRight.y * lane };

    if (car.exitDirection === car.entryDirection) {
      return { start, bend: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, end };
    }
    if (car.exitDirection === oppositeOf(car.entryDirection)) {
      return { start, bend: { x: entry.x * TRAFFIC.U_TURN_DEPTH, y: entry.y * TRAFFIC.U_TURN_DEPTH }, end };
    }
    // A turn bends where the incoming and outgoing lanes cross.
    return { start, bend: { x: (entryRight.x + exitRight.x) * lane, y: (entryRight.y + exitRight.y) * lane }, end };
  }

  const mix = (from, to, amount) => ({ x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount });

  /** Point on the ring road: steer from the tile edge onto the ring, circle, steer off again. */
  function roundaboutPoint({ start, end }, t) {
    const radius = TRAFFIC.ROUNDABOUT_LANE_RADIUS;
    const blend = TRAFFIC.ROUNDABOUT_BLEND;
    const startAngle = Math.atan2(start.y, start.x);
    const sweep = roundaboutSweep(start, end);
    const onRing = (angle) => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    if (t < blend) return mix(start, onRing(startAngle), t / blend);
    if (t > 1 - blend) return mix(onRing(startAngle - sweep), end, (t - (1 - blend)) / blend);
    return onRing(startAngle - (sweep * (t - blend)) / (1 - blend * 2));
  }

  /** Where a car is within its tile (relative to the tile centre) at progress t. */
  function pointOnPath(car, t) {
    const path = pathThroughTile(car);
    if (car.isOnRoundabout) return roundaboutPoint(path, t);
    const u = 1 - t;
    return {
      x: u * u * path.start.x + 2 * u * t * path.bend.x + t * t * path.end.x,
      y: u * u * path.start.y + 2 * u * t * path.bend.y + t * t * path.end.y,
    };
  }

  /** Position (in tiles) and heading of a car. */
  function carPose(car) {
    const here = pointOnPath(car, car.progress);
    const behind = pointOnPath(car, car.progress - TRAFFIC.HEADING_SAMPLE);
    const ahead = pointOnPath(car, car.progress + TRAFFIC.HEADING_SAMPLE);
    return {
      x: car.col + 0.5 + here.x,
      y: car.row + 0.5 + here.y,
      angle: Math.atan2(ahead.y - behind.y, ahead.x - behind.x),
    };
  }

  function createTraffic({ cellKey, JUNCTION, signalPhase, random = Math.random }) {
    if (typeof cellKey !== 'function' || typeof signalPhase !== 'function' || !JUNCTION) {
      throw new Error('Traffic needs cellKey, JUNCTION and signalPhase.');
    }

    let cars = [];
    let homeDoorsteps = []; // road tiles in front of houses: where trips start and end
    let shopDoorsteps = [];
    let congestion = 0; // smoothed share of cars standing still, 0..1
    let uncollectedTolls = 0; // cars that have passed a gate since the game last collected
    let knownShops = null;
    let targetCarCount = 0;
    let secondsSinceSpawn = 0;
    let clockSeconds = 0; // drives the traffic lights
    let junctions = new Map(); // the map's junction features, as last seen by step()
    let knownRoads = null;
    let knownHouses = null;
    const pickRandom = (items) => items[Math.floor(random() * items.length)];
    const parseKey = (key) => {
      const [col, row] = key.split(',').map(Number);
      return { col, row };
    };

    function linkedDirections(roads, col, row) {
      return DIRECTIONS.map((_, index) => index).filter((index) =>
        roads.has(cellKey(col + DIRECTIONS[index].x, row + DIRECTIONS[index].y))
      );
    }

    /** Recomputed only when the map changes: where trips start and end, and how many cars there should be. */
    function surveyMap(roads, houses, shops) {
      const isDrivable = (col, row) =>
        roads.has(cellKey(col, row)) && linkedDirections(roads, col, row).length > 0;
      const doorsteps = (buildings) =>
        [...buildings].map(parseKey).flatMap(({ col, row }) => {
          const side = DIRECTIONS.find((d) => isDrivable(col + d.x, row + d.y));
          return side ? [{ col: col + side.x, row: row + side.y }] : [];
        });
      homeDoorsteps = doorsteps(houses);
      shopDoorsteps = doorsteps(shops);
      targetCarCount = Math.min(TRAFFIC.MAX_CARS, Math.ceil(homeDoorsteps.length * TRAFFIC.CARS_PER_HOUSE));
    }

    const junctionAt = (col, row) => junctions.get(cellKey(col, row));
    const laneKey = (col, row, entryDirection) => cellKey(col, row) + ',' + entryDirection;
    const isEastWest = (direction) => direction % 2 === 1;

    /** Directions a car may leave a tile in without turning back. */
    function onwardDirections(roads, col, row, entryDirection) {
      const links = linkedDirections(roads, col, row);
      const type = junctionAt(col, row);
      // On a bridge the two roads do not meet, so the only way is straight across.
      if (type === JUNCTION.BRIDGE_EW || type === JUNCTION.BRIDGE_NS) {
        return links.includes(entryDirection) ? [entryDirection] : [];
      }
      return links.filter((direction) => direction !== oppositeOf(entryDirection));
    }

    /** A random way out of a tile, turning back only at a dead end. Null if there is no way out. */
    function chooseExit(roads, col, row, entryDirection) {
      const onward = onwardDirections(roads, col, row, entryDirection);
      if (onward.length > 0) return pickRandom(onward);
      const wayBack = oppositeOf(entryDirection);
      return linkedDirections(roads, col, row).includes(wayBack) ? wayBack : null;
    }

    /**
     * Shortest route between two road tiles, as the list of directions to leave
     * each tile in, or null if there is none. Breadth-first search over
     * (tile, direction of arrival), because what is allowed next depends on
     * how a tile was entered (no turning back, straight on across bridges).
     */
    function findRoute(roads, origin, destination) {
      if (origin.col === destination.col && origin.row === destination.row) return null;
      const cameFrom = new Map(); // search state -> the state before it (null for a first step)
      const keyOf = (state) => laneKey(state.col, state.row, state.direction);
      const stepFrom = (place, direction) => ({
        col: place.col + DIRECTIONS[direction].x,
        row: place.row + DIRECTIONS[direction].y,
        direction,
      });
      const visit = (state, previous) => {
        if (cameFrom.has(keyOf(state))) return false;
        cameFrom.set(keyOf(state), previous);
        return true;
      };

      let frontier = linkedDirections(roads, origin.col, origin.row)
        .map((direction) => stepFrom(origin, direction))
        .filter((state) => visit(state, null));
      while (frontier.length > 0) {
        const arrival = frontier.find((state) => state.col === destination.col && state.row === destination.row);
        if (arrival) {
          const route = [];
          for (let state = arrival; state; state = cameFrom.get(keyOf(state))) route.unshift(state.direction);
          return route;
        }
        frontier = frontier.flatMap((state) =>
          onwardDirections(roads, state.col, state.row, state.direction)
            .map((direction) => stepFrom(state, direction))
            .filter((next) => visit(next, state))
        );
      }
      return null;
    }

    /** Next move for a car entering a tile: follow its route, else improvise. Null if its trip is over. */
    function planExit(roads, car, next) {
      if (car.route) {
        if (car.routeStep >= car.route.length) return null; // arrived
        const wanted = car.route[car.routeStep];
        const isStillPossible = onwardDirections(roads, next.col, next.row, car.exitDirection).includes(wanted);
        if (isStillPossible) return { exitDirection: wanted, routeStep: car.routeStep + 1 };
      }
      const exitDirection = chooseExit(roads, next.col, next.row, car.exitDirection);
      return exitDirection === null ? null : { exitDirection, route: null };
    }

    /** A new car leaving a house for a shop, or a shop for a house — or just wandering if there are no shops. */
    function spawnCar(roads) {
      if (homeDoorsteps.length === 0) return null;
      const home = pickRandom(homeDoorsteps);
      const shop = shopDoorsteps.length > 0 ? pickRandom(shopDoorsteps) : null;
      const [origin, destination] = shop && random() < 0.5 ? [shop, home] : [home, shop];
      const route = destination ? findRoute(roads, origin, destination) : null;
      const links = linkedDirections(roads, origin.col, origin.row);
      if (links.length === 0) return null;
      const direction = route ? route[0] : pickRandom(links);
      return {
        col: origin.col,
        row: origin.row,
        entryDirection: direction,
        exitDirection: direction,
        progress: 0.5, // start mid-tile rather than at an edge that may have no road behind it
        speed: TRAFFIC.MIN_SPEED + random() * (TRAFFIC.MAX_SPEED - TRAFFIC.MIN_SPEED),
        color: pickRandom(TRAFFIC.BODY_COLORS),
        age: 0,
        isOnRoundabout: junctionAt(origin.col, origin.row) === JUNCTION.ROUNDABOUT,
        isWaiting: false,
        route, // directions still to take, or null for a car with no destination
        routeStep: 1,
      };
    }

    /** Where every car is right now, grouped by lane and by tile, so cars can look ahead. */
    function snapshotTraffic() {
      const lanes = new Map();
      const tiles = new Map();
      const record = (group, key, progress) => group.set(key, [...(group.get(key) || []), progress]);
      cars.forEach((car) => {
        record(lanes, laneKey(car.col, car.row, car.entryDirection), car.progress);
        record(tiles, cellKey(car.col, car.row), car.progress);
      });
      return { lanes, tiles };
    }

    function hasCarCloseAhead(car, lanes) {
      const lane = lanes.get(laneKey(car.col, car.row, car.entryDirection)) || [];
      return lane.some((progress) => progress > car.progress && progress - car.progress < TRAFFIC.FOLLOW_GAP);
    }

    /** May this car, waiting at the end of its tile, not yet drive into the next one? */
    function isEntryBlocked(car, next, snapshot) {
      const type = junctionAt(next.col, next.row);
      // A car that has already passed the stop line clears the junction even if the light changes.
      if (type === JUNCTION.SIGNAL && car.progress <= TRAFFIC.STOP_LINE) {
        const phase = signalPhase(clockSeconds);
        if ((isEastWest(car.exitDirection) ? phase.ew : phase.ns) !== 'green') return true;
      }
      // Give way to cars that have only just entered the roundabout.
      const circulating = snapshot.tiles.get(cellKey(next.col, next.row)) || [];
      if (type === JUNCTION.ROUNDABOUT && circulating.some((p) => p < TRAFFIC.ROUNDABOUT_CLEAR_PROGRESS)) {
        return true;
      }
      const roomNeeded = TRAFFIC.FOLLOW_GAP - (1 - car.progress);
      const laneAhead = snapshot.lanes.get(laneKey(next.col, next.row, car.exitDirection)) || [];
      return laneAhead.some((progress) => progress < roomNeeded);
    }

    /** Returns the car one step later, or null if its road was removed from under it. */
    function advanceCar(car, deltaSeconds, roads, snapshot) {
      if (!roads.has(cellKey(car.col, car.row))) return null;
      if (!car.route && car.age > TRAFFIC.WANDER_SECONDS) return null;
      const age = car.age + deltaSeconds;
      if (hasCarCloseAhead(car, snapshot.lanes)) return { ...car, age, isWaiting: true };

      const pace = junctionAt(car.col, car.row) === JUNCTION.TOLL ? TRAFFIC.TOLL_PACE : 1;
      const progress = car.progress + (deltaSeconds * car.speed * pace) / pathLength(car);
      const heading = DIRECTIONS[car.exitDirection];
      const next = { col: car.col + heading.x, row: car.row + heading.y };
      const hasRoadAhead = roads.has(cellKey(next.col, next.row));
      if (progress >= TRAFFIC.STOP_LINE && hasRoadAhead && isEntryBlocked(car, next, snapshot)) {
        return { ...car, age, isWaiting: true, progress: Math.max(car.progress, Math.min(progress, TRAFFIC.STOP_LINE)) };
      }
      if (progress < 1) return { ...car, progress, age, isWaiting: false };

      if (!hasRoadAhead) return null;
      const plan = planExit(roads, car, next);
      if (plan === null) return null;
      return {
        ...car,
        ...next,
        ...plan,
        entryDirection: car.exitDirection,
        isWaiting: false,
        // Stamped with the current step's time, so step() can count this entry exactly once.
        tollEnteredAt: junctionAt(next.col, next.row) === JUNCTION.TOLL ? clockSeconds : null,
        progress: progress - 1,
        age,
        isOnRoundabout: junctionAt(next.col, next.row) === JUNCTION.ROUNDABOUT,
      };
    }

    function step(deltaSeconds, roads, houses, shops, currentJunctions) {
      clockSeconds += deltaSeconds;
      junctions = currentJunctions;
      if (roads !== knownRoads || houses !== knownHouses || shops !== knownShops) {
        surveyMap(roads, houses, shops);
        knownRoads = roads;
        knownHouses = houses;
        knownShops = shops;
      }

      const snapshot = snapshotTraffic();
      cars = cars
        .map((car) => advanceCar(car, deltaSeconds, roads, snapshot))
        .filter(Boolean)
        .slice(0, targetCarCount);
      const waitingShare = cars.length === 0 ? 0 : cars.filter((car) => car.isWaiting).length / cars.length;
      uncollectedTolls += cars.filter((car) => car.tollEnteredAt === clockSeconds).length;
      congestion += (waitingShare - congestion) * Math.min(1, deltaSeconds / TRAFFIC.CONGESTION_SMOOTHING_SECONDS);

      secondsSinceSpawn += deltaSeconds;
      if (cars.length >= targetCarCount || secondsSinceSpawn < TRAFFIC.SPAWN_INTERVAL_SECONDS) return;
      secondsSinceSpawn = 0;
      const newCar = spawnCar(roads);
      if (newCar) cars = [...cars, newCar];
    }

    /** True for a car on the upper road of a bridge; everything else is at ground level. */
    function isOnBridgeDeck(car) {
      const type = junctionAt(car.col, car.row);
      return (
        (type === JUNCTION.BRIDGE_EW && isEastWest(car.entryDirection)) ||
        (type === JUNCTION.BRIDGE_NS && !isEastWest(car.entryDirection))
      );
    }

    function drawCar(ctx, car, cellSize) {
      const pose = carPose(car);
      const length = TRAFFIC.CAR_LENGTH * cellSize;
      const width = TRAFFIC.CAR_WIDTH * cellSize;

      ctx.save();
      ctx.translate(pose.x * cellSize, pose.y * cellSize);
      ctx.rotate(pose.angle);
      ctx.globalAlpha = Math.min(car.age / TRAFFIC.FADE_IN_SECONDS, 1);
      ctx.fillStyle = car.color;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(-length / 2, -width / 2, length, width, width * 0.3);
      } else {
        ctx.rect(-length / 2, -width / 2, length, width);
      }
      ctx.fill();
      ctx.fillStyle = TRAFFIC.WINDSHIELD_COLOR;
      ctx.fillRect(length * 0.08, -width * 0.36, length * 0.2, width * 0.72);
      ctx.restore();
    }

    return {
      step,
      /** Draws one layer of cars: those on bridge decks, or (the default) those on the ground. */
      draw(ctx, cellSize, { isDeckLayer = false } = {}) {
        cars.filter((car) => isOnBridgeDeck(car) === isDeckLayer).forEach((car) => drawCar(ctx, car, cellSize));
      },
      getCarCount: () => cars.length,
      /** Number of cars that drove into a toll gate since the last call. */
      collectTolls() {
        const count = uncollectedTolls;
        uncollectedTolls = 0;
        return count;
      },
      /** Smoothed share of cars standing in a queue or at a red light, 0..1. */
      getCongestion: () => congestion,
      getClockSeconds: () => clockSeconds,
    };
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, { createTraffic });
})();
