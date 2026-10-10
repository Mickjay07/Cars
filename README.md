# Road Game Builder

A browser-based road-building game. You lay out roads on an empty piece of land, people move in along them, and their taxes pay for the next road. It is inspired by Cities: Skylines, but deliberately much smaller.

This is an early prototype. The numbers (prices, tax income, how fast people move) are first guesses and have not been balanced.

## What works today

**Building**
- A tile map that scales to fit the browser window. Its size and landscape are chosen when the city is founded (see "Welcome screen and worlds").
- **Water** — sea, rivers and lakes. Buildings cannot stand in water and houses do not appear there; a road can cross it as a causeway at six times the price.
- **Roads** — click or drag. Tiles join their neighbours into straights, corners and intersections; fast drags are filled in so a road never has gaps.
- **Shops** — placed by you on empty land. Each provides 12 jobs and is a destination for cars.
- **Parks** — placed by you on empty land. They lift the mood; the full effect needs about one park for every four houses.
- **Toll gates** — click a road tile with no side roads. Every car driving through pays $2, but cars crawl through the gate, and each gate lowers the mood a little.
- **Traffic lights, roundabouts, bridges** — click an intersection (a four-way crossing for a bridge). Click a bridge again to swap which road is on top, a third time to remove it. The road underneath a bridge is the underpass.
- **Bulldozer** — click or drag, or right-drag with any tool. Removes roads, houses, shops and parks.
- A tile holds one thing: a road, a house, a shop or a park.

**Money**
- You start with $2,000. Prices: road $10, shop $150, park $80, toll gate $250, traffic lights $100, roundabout $200, bridge $500, demolition $5 per tile.
- A build you cannot afford is simply refused; the money figure turns red when the selected tool costs more than you have.
- Every day (one second at normal speed) residents pay tax and you pay upkeep for roads, shops and parks.

**Residents, taxes and mood**
- **Houses build themselves** on empty tiles beside roads while residents are content. You cannot place them, only demolish them. Each house holds 4 residents.
- You set the **tax rate** (0–20%) with the slider. More tax is more income, but mood drifts down: above 8% people grumble.
- **Mood** (0–100%) is lowered by high taxes, by a shortage of jobs, by traffic standing still and by toll gates, and raised by parks. From 50% up people move in, faster the happier they are; below 35% they **move out** and houses disappear.
- The City panel shows the daily budget, the current mood and what residents are complaining about.

**Traffic**
- Cars drive between houses and shops along the shortest route, then leave the road. With no shops they wander for a while instead. There are about 0.6 cars on the road per connected house, 60 at most.
- Cars keep to the right, keep a gap behind the car ahead, stop at red and yellow lights, give way when entering a roundabout and go straight across bridges.

**Game flow**
- **Goals** by population: 20 residents unlocks traffic lights, 60 roundabouts, 120 bridges, 250 is the last goal. Each pays a cash reward. Unlocks follow the highest population you have reached, so they are not lost if people leave.
- **Speed**: pause, 1× and 3×. You can build while paused.
- **Welcome screen and worlds**: the game opens on a welcome screen with three save slots. Each can be continued or replaced with a new world. A new world asks for:
  - **Difficulty** — Easy ($3,000, forgiving residents), Normal ($2,000) or Hard ($1,200, residents react 40% more strongly to taxes, jams, unemployment and toll gates).
  - **Map size** — Small 28 × 18, Medium 40 × 24 or Large 56 × 34 tiles.
  - **Landscape** — open plain, island, coast or river valley, with optional lakes. The land is generated at random each time.
- **Saving**: the city being played saves itself in its slot a couple of seconds after anything changes. "Save and exit to menu" in City hall returns to the welcome screen.
- **Accounts** (optional): the welcome screen lets a player create an account or sign in with an e-mail address and password. While signed in, the city being played is uploaded every 30 seconds, and signing in on another browser copies the account's cities into its slots. This needs the Supabase project named in `config.js`, with `supabase-setup.sql` run once in it, and an internet connection (the Supabase library is loaded from a CDN). Signed out or offline, the game saves in the browser only.
- Keyboard: `R` road, `S` shop, `P` park, `L` toll gate, `T` traffic lights, `O` roundabout, `G` bridge, `B` bulldozer, `Space` pause.

## What does not exist yet, and known rough edges

- Intersections without lights or a roundabout have no right of way: cars from different directions drive through each other. Cars stop abruptly rather than braking and can overlap where they appear or inside a roundabout.
- Traffic jams lower the mood of the whole city, not of the houses near the jam.
- Each trip is independent: a car is not tied to a particular house or resident, and nobody has to reach a shop for it to count as their job.
- There is no way to lose and no penalty for debt beyond being unable to build (including being unable to pay demolition fees).
- All traffic lights share one timing. Roundabouts and bridges are one tile each; there are no ramps or longer bridges.
- Parks and toll gates affect the whole city equally, wherever they stand. More building types and per-area statistics are not implemented.
- There is no undo and no way to delete a save slot other than replacing it with a new world. Two browsers signed in to the same account at once overwrite each other (last upload wins).
- Accounts have no password reset, no way to change e-mail or delete the account from inside the game, and no leaderboard.
- Signing in, creating an account and the cloud round trip have not been tested end to end; only the signed-out welcome screen, local slots and world generation were checked.
- Landscapes are simple: an island can come out with a lake cut off by water, and nothing guarantees a minimum amount of buildable land.
- There are no pedestrians and no public transport.
- No automated tests. The game has been tested by hand with a mouse in a desktop browser; touch and phone-sized screens have had only a layout check.

## Running it locally

No build step and no dependencies. Either open `index.html` directly in a browser, or serve the folder with any static server:

```bash
python3 -m http.server 8123
```

then visit <http://localhost:8123>. To deploy, upload the files as they are to any static host.

## Project structure

```
index.html    page structure
style.css     interface styling
game.js       map state and actions, tools, input, rendering, game loop
interface.js  tool buttons, top-bar figures, city panel, speed, keyboard
city.js       money, taxes, mood, houses moving in and out, goals
traffic.js    cars: trips and routes, movement, queueing, drawing
junctions.js  traffic lights, roundabouts, bridges: rules, timing, drawing
buildings.js  how houses, shops and parks are drawn
terrain.js    the grass, grid and trees under everything
worlds.js     difficulty, map sizes, landscapes and random water generation
menu.js       the welcome screen: account, save slots, new-world choices
storage.js    the three save slots in the browser, checking saved data
cloud.js      accounts and cloud saves through Supabase
config.js     Supabase project URL and publishable key
supabase-setup.sql  one-time database setup for cloud saves
```

The scripts are plain (non-module) files so the game also runs from disk. Each registers its functions on `window.RoadGameModules`, and `game.js` must load last (see the script tags in `index.html`).

The game state lives in one store in `game.js`: sets of `"column,row"` keys for roads, houses and shops, a map of junction features, the `city` object (money, tax rate, happiness, peak population, day), the `world` (size, landscape, difficulty, seed) with its generated water, the save slot being played, the selected tool and the speed. State is never modified in place; every change produces a new state. Cars are not part of it — `traffic.js` keeps its own list and is only shown the map.

For debugging, `roadGameBuilder.getState()` in the browser console returns the current state.

## Ideas for later

- Pedestrians, and residents with specific requests (for example a park near their street)
- Public transport: buses, later a metro
- A leaderboard of the biggest cities, password reset
- Right of way at plain intersections, smoother braking
- Mood and congestion per neighbourhood instead of city-wide
- A tax or loan consequence for running out of money
- More building types
