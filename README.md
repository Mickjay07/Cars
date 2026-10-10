# Road Game Builder

A browser-based road-building game. You start with an empty piece of land and lay out your own road network, tile by tile. It is inspired by Cities: Skylines, but deliberately much smaller.

This is an early prototype: it has the core building loop and nothing else yet.

## Current milestone — Day 2: Defining the Core Gameplay

The goal of this milestone is the basic loop, playable with no tutorial or account:

1. Start with an empty map.
2. Pick the road tool and build a network.
3. Experiment with layouts.
4. Bulldoze or rework roads.
5. Keep improving the network.

## What works today

- A top-down 40 × 24 tile map with green terrain and a subtle grid. The map scales to fit the browser window and stays centred when the window is resized.
- **Road tool** — click a tile to place a road, or hold and drag to lay a connected stretch. Fast drags are filled in, so a dragged road never has gaps.
- **Automatic connections** — each road tile joins its neighbours, so straights, corners, T-junctions and crossroads form from where you place tiles. Lane markings are drawn on straights and corners.
- **No duplicates** — a tile holds at most one road segment; building over an existing road does nothing.
- **Bulldozer tool** — click or drag over roads to remove them. Right-click-drag bulldozes regardless of the selected tool.
- **Clear map** — removes everything, after a confirmation dialog.
- **Road segment counter** in the top bar.
- Keyboard shortcuts: `R` for road, `B` for bulldozer.
- Small touches: hover highlight on the tile under the cursor, a short grow-in when a road is placed, a brief fade when one is removed. Animations are skipped if the system asks for reduced motion.

## What does not exist yet

There are no vehicles, no traffic, no traffic lights, no buildings, no money or goals, and no saving — **the map is lost when the page is reloaded**. There is no undo. Roads are purely visual tiles: an "intersection" is just a tile with three or four road neighbours, with no rules attached.

The layout adapts to narrow screens and touch input goes through the same pointer handling as the mouse, but the game has only been tested with a mouse in a desktop browser.

## Running it locally

No build step and no dependencies. Either:

- open `index.html` directly in a browser, or
- serve the folder with any static server, for example:

  ```bash
  python3 -m http.server 8123
  ```

  then visit <http://localhost:8123>.

To deploy, upload the files as they are to any static host (GitHub Pages, Netlify, Cloudflare Pages, …).

## Project structure

```
index.html   page structure: top bar, tool sidebar, canvas, clear-map dialog
style.css    interface styling
game.js      the game itself
README.md    this file
```

`game.js` is one file split into sections that only communicate through a small state store:

| Section      | Responsibility                                                    |
| ------------ | ----------------------------------------------------------------- |
| CONFIG       | Grid size, colours, animation timings                             |
| Grid         | Tile maths: keys, bounds, the tile-by-tile path between two tiles |
| Road network | Pure functions that add and remove road segments                  |
| Store        | Holds the game state (`roads`, `activeTool`) and notifies on change |
| Renderer     | Draws the state to the canvas                                     |
| Input        | Turns pointer events into tool strokes                            |
| Interface    | Toolbar, counter, clear-map dialog, keyboard shortcuts            |

The game state is a set of `"column,row"` keys plus the selected tool. Future systems are meant to plug into the store the same way the renderer does, rather than reaching into each other.

For debugging, `roadGameBuilder.getState()` in the browser console returns the current state.

## Planned features

None of these are implemented. Roughly in the order they are likely to arrive:

- Saving and loading maps
- Vehicles driving along roads
- Intersections with rules, and traffic lights
- Traffic simulation and congestion
- Road statistics
- Buildings and city development
