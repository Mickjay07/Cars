/*
 * Road Game Builder — the interface around the map: tool buttons, top-bar
 * figures, the city panel (taxes, budget, mood, next goal), game speed, the
 * new-city dialog and keyboard shortcuts.
 *
 * It reads the game state and sends actions back to the store; it holds no
 * game state of its own.
 */
(function () {
  'use strict';

  // Happiness thresholds, highest first.
  const MOODS = Object.freeze([
    Object.freeze({ from: 75, label: 'Happy — people are moving in' }),
    Object.freeze({ from: 50, label: 'Content — the town grows slowly' }),
    Object.freeze({ from: 35, label: 'Grumbling — nobody new is coming' }),
    Object.freeze({ from: 0, label: 'Furious — people are moving out' }),
  ]);
  const NOTICEABLE_SHARE = 0.3; // unemployment or congestion above this is named as a complaint
  const PAUSED = 0;

  function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing page element: #' + id);
    return element;
  }

  function formatMoney(amount) {
    return (amount < 0 ? '-$' : '$') + Math.abs(Math.round(amount)).toLocaleString('en-US');
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function attachNewCityControl(store, actions) {
    const button = requireElement('clear-map');
    const dialog = requireElement('clear-dialog');
    const canUseDialog = typeof dialog.showModal === 'function';

    button.addEventListener('click', () => {
      if (canUseDialog) {
        dialog.showModal();
        return;
      }
      if (window.confirm('Start a new city? The map, money and progress are all reset.')) store.update(actions.newCity());
    });
    // Only the confirm button resets; Escape and "Keep building" just close the dialog.
    // Handled on submit (not the later, asynchronous `close` event) so the map is
    // already empty by the time the player can touch it again.
    dialog.addEventListener('submit', (event) => {
      if (event.submitter && event.submitter.value === 'confirm') store.update(actions.newCity());
    });
    return { isDialogOpen: () => Boolean(dialog.open) };
  }

  function attachInterface(store, canvas, { actions, TOOLS, STATUS_HINTS }) {
    const modules = window.RoadGameModules;
    const { CITY } = modules;
    const toolButtons = [...document.querySelectorAll('button[data-tool]')];
    const speedButtons = [...document.querySelectorAll('button[data-speed]')];
    const elements = Object.freeze({
      money: requireElement('money-count'),
      residents: requireElement('resident-count'),
      mood: requireElement('mood-count'),
      roads: requireElement('segment-count'),
      cars: requireElement('car-count'),
      taxSlider: requireElement('tax-rate'),
      taxValue: requireElement('tax-value'),
      budget: requireElement('budget-line'),
      moodLine: requireElement('mood-line'),
      goal: requireElement('goal-text'),
      statusHint: requireElement('status-hint'),
      statusCell: requireElement('status-cell'),
    });
    const { isDialogOpen } = attachNewCityControl(store, actions);
    let congestion = 0; // last figure reported by the traffic, only used to explain the mood

    const TOOL_SHORTCUTS = Object.freeze({
      r: TOOLS.ROAD,
      s: TOOLS.SHOP,
      p: TOOLS.PARK,
      l: TOOLS.TOLL,
      t: TOOLS.SIGNAL,
      o: TOOLS.ROUNDABOUT,
      g: TOOLS.BRIDGE,
      b: TOOLS.BULLDOZER,
    });

    toolButtons.forEach((button) => {
      button.addEventListener('click', () => store.update(actions.selectTool(button.dataset.tool)));
    });
    speedButtons.forEach((button) => {
      button.addEventListener('click', () => store.update(actions.setSpeed(Number(button.dataset.speed))));
    });
    elements.taxSlider.min = String(CITY.MIN_TAX);
    elements.taxSlider.max = String(CITY.MAX_TAX);
    elements.taxSlider.addEventListener('input', () => store.update(actions.setTaxRate(Number(elements.taxSlider.value))));

    window.addEventListener('keydown', (event) => {
      // Letters typed into a dialog (for example an e-mail address) are not tool shortcuts.
      const isAnyDialogOpen = isDialogOpen() || document.querySelector('dialog[open]') !== null;
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isAnyDialogOpen) return;
      const isTypingIntoControl = ['BUTTON', 'INPUT'].includes(event.target.tagName);
      if (event.key === ' ' && !isTypingIntoControl) {
        event.preventDefault();
        store.update(actions.setSpeed(store.getState().speed === PAUSED ? 1 : PAUSED));
        return;
      }
      const tool = TOOL_SHORTCUTS[event.key.toLowerCase()];
      if (tool) store.update(actions.selectTool(tool));
    });

    function renderTools(state) {
      toolButtons.forEach((button) => {
        const tool = button.dataset.tool;
        const goal = modules.GOALS.find((candidate) => candidate.unlocks === tool);
        const isLocked = !modules.isToolUnlocked(tool, state.city);
        button.disabled = isLocked;
        button.title = isLocked ? 'Unlocks at ' + goal.population + ' residents' : '';
        button.setAttribute('aria-pressed', String(tool === state.activeTool));
        const price = modules.priceOfTool(tool);
        const priceText = price > 0 ? formatMoney(price) : formatMoney(CITY.DEMOLITION_FEE) + ' a tile';
        setText(button.querySelector('.tool-price'), isLocked ? 'at ' + goal.population + ' residents' : priceText);
      });
      speedButtons.forEach((button) => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === state.speed));
      });
      canvas.dataset.tool = state.activeTool;
      setText(elements.statusHint, state.speed === PAUSED ? 'Paused — you can still build' : STATUS_HINTS[state.activeTool]);
    }

    function complaints(state) {
      const population = modules.populationOf(state);
      const jobShortage = population === 0 ? 0 : 1 - modules.jobsOf(state) / (population * CITY.WORKING_SHARE);
      return [
        state.city.taxRate > CITY.NEUTRAL_TAX ? 'high taxes' : null,
        jobShortage > NOTICEABLE_SHARE ? 'not enough jobs (build shops)' : null,
        congestion > NOTICEABLE_SHARE ? 'traffic jams' : null,
        modules.tollCountOf(state) > 0 ? 'toll gates' : null,
        population > 0 && state.parks.size === 0 ? 'no parks' : null,
      ].filter(Boolean);
    }

    function renderCity(state) {
      const { city } = state;
      const population = modules.populationOf(state);
      const budget = modules.dailyBudget(state);
      const mood = MOODS.find((candidate) => city.happiness >= candidate.from);
      const grievances = complaints(state);
      const goal = modules.nextGoal(city);

      setText(elements.money, formatMoney(city.money));
      elements.money.classList.toggle('is-short', city.money < modules.priceOfTool(state.activeTool));
      setText(elements.residents, String(population));
      setText(elements.mood, Math.round(city.happiness) + '%');
      setText(elements.roads, String(state.roads.size));
      if (Number(elements.taxSlider.value) !== city.taxRate) elements.taxSlider.value = String(city.taxRate);
      setText(elements.taxValue, city.taxRate + '%');
      setText(
        elements.budget,
        formatMoney(budget.income) + ' taxes − ' + formatMoney(budget.upkeep) + ' upkeep = ' + formatMoney(budget.balance) + ' a day'
      );
      setText(elements.moodLine, mood.label + (grievances.length > 0 ? '. Complaints: ' + grievances.join(', ') + '.' : '.'));
      setText(
        elements.goal,
        goal
          ? population + ' / ' + goal.population + ' residents → ' + goal.label + ', +' + formatMoney(goal.reward)
          : 'All goals reached.'
      );
    }

    function render(state) {
      renderTools(state);
      renderCity(state);
    }

    store.subscribe(render);
    render(store.getState());

    return {
      showTraffic(carCount, currentCongestion) {
        congestion = currentCongestion;
        setText(elements.cars, String(carCount));
      },
      showCursorCell(cell) {
        setText(elements.statusCell, cell ? 'Tile ' + (cell.col + 1) + ', ' + (cell.row + 1) : '');
      },
    };
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, { attachInterface, requireElement });
})();
