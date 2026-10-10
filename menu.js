/*
 * Road Game Builder — the welcome screen.
 *
 * Shown over the game before play and whenever the player leaves a city. It
 * handles signing in and out, lists the three save slots, and collects the
 * choices for a new world (difficulty, map size, landscape, lakes).
 *
 * It starts and stops play through two store actions it is given
 * (`enterWorld`, `exitToMenu`) and otherwise leaves the game alone.
 */
(function () {
  'use strict';

  const MIN_PASSWORD_LENGTH = 6; // Supabase's own minimum
  const CHOICE_TABLES = Object.freeze({ difficulty: 'DIFFICULTIES', size: 'SIZES', shape: 'SHAPES' });
  const DEFAULT_CHOICES = Object.freeze({ difficulty: 'normal', size: 'medium', shape: 'plain' });

  function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing page element: #' + id);
    return element;
  }

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function formatMoney(amount) {
    return (amount < 0 ? '-$' : '$') + Math.abs(Math.round(amount)).toLocaleString('en-US');
  }

  /** Fills each <div data-choice="…"> with one radio button per option in the matching table. */
  function buildChoices(form, modules) {
    Object.entries(CHOICE_TABLES).forEach(([name, tableName]) => {
      const holder = form.querySelector('[data-choice="' + name + '"]');
      if (!holder) throw new Error('Missing choice group: ' + name);
      Object.entries(modules[tableName]).forEach(([value, option]) => {
        const label = make('label', 'choice');
        const input = make('input');
        input.type = 'radio';
        input.name = name;
        input.value = value;
        input.checked = value === DEFAULT_CHOICES[name];
        label.append(input, make('span', '', option.label));
        holder.append(label);
      });
    });
  }

  function startMenu({ store, actions, rules, freshMap, cloud }) {
    const modules = window.RoadGameModules;
    const home = requireElement('menu-home');
    const slotList = requireElement('slot-list');
    const worldForm = requireElement('world-form');
    const worldFormTitle = requireElement('world-form-title');
    const difficultyNote = requireElement('difficulty-note');
    const accountStatus = requireElement('menu-account-status');
    const accountForm = requireElement('account-form');
    const accountMessage = requireElement('account-message');
    const signOutButton = requireElement('sign-out-button');
    const emailField = requireElement('account-email');
    const passwordField = requireElement('account-password');

    let user = null;
    let slotForNewWorld = null;

    // ----- save slots

    function describeSave(raw) {
      const city = raw.city && typeof raw.city === 'object' ? raw.city : {};
      const residents = (Array.isArray(raw.houses) ? raw.houses.length : 0) * modules.CITY.RESIDENTS_PER_HOUSE;
      const savedOn = Number.isFinite(raw.savedAt)
        ? new Date(raw.savedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : 'unknown';
      return {
        headline: residents + ' residents · ' + formatMoney(Number(city.money) || 0) + ' · day ' + (Number(city.day) || 0),
        detail: modules.describeWorld(raw.world) + ' · saved ' + savedOn,
      };
    }

    function slotCard(slot) {
      const raw = modules.readSlotRaw(slot);
      const card = make('li', 'slot');
      const text = make('div', 'slot-text');
      const buttons = make('div', 'slot-buttons');
      text.append(make('strong', 'slot-name', 'City ' + slot));
      if (raw) {
        const { headline, detail } = describeSave(raw);
        text.append(make('span', 'slot-headline', headline), make('span', 'note', detail));
        const continueButton = make('button', 'button button-accent', 'Continue');
        continueButton.type = 'button';
        continueButton.addEventListener('click', () => continueCity(slot));
        buttons.append(continueButton);
      } else {
        text.append(make('span', 'note', 'Empty'));
      }
      const newButton = make('button', raw ? 'button' : 'button button-accent', 'New world');
      newButton.type = 'button';
      newButton.addEventListener('click', () => openWorldForm(slot, Boolean(raw)));
      buttons.append(newButton);
      card.append(text, buttons);
      return card;
    }

    const renderSlots = () => slotList.replaceChildren(...modules.SLOTS.map(slotCard));

    function closeMenu() {
      document.body.classList.remove('is-in-menu');
    }

    function continueCity(slot) {
      const saved = modules.loadSlot(slot, rules);
      if (!saved) {
        accountMessage.textContent = 'City ' + slot + ' could not be read.';
        return;
      }
      const { savedAt, ...map } = saved;
      store.update(actions.enterWorld(slot, map));
      closeMenu();
    }

    // ----- new world

    function showHome() {
      worldForm.hidden = true;
      home.hidden = false;
      renderSlots();
    }

    function renderDifficultyNote() {
      const chosen = new FormData(worldForm).get('difficulty');
      difficultyNote.textContent = (modules.DIFFICULTIES[chosen] || {}).note || '';
    }

    function openWorldForm(slot, isReplacing) {
      const warning = 'Replace City ' + slot + ' with a new world? The city saved there will be lost.';
      if (isReplacing && !window.confirm(warning)) return;
      slotForNewWorld = slot;
      worldFormTitle.textContent = 'New world in City ' + slot;
      renderDifficultyNote();
      home.hidden = true;
      worldForm.hidden = false;
    }

    worldForm.addEventListener('change', renderDifficultyNote);
    requireElement('world-back').addEventListener('click', showHome);
    worldForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (slotForNewWorld === null) return;
      const choices = new FormData(worldForm);
      const world = modules.createWorld({
        difficulty: choices.get('difficulty'),
        size: choices.get('size'),
        shape: choices.get('shape'),
        lakes: choices.get('lakes') === 'on',
      });
      store.update(actions.enterWorld(slotForNewWorld, freshMap(world)));
      modules.saveSlot(slotForNewWorld, store.getState());
      closeMenu();
    });

    // ----- account

    function renderAccount() {
      const isAvailable = cloud.isEnabled;
      accountForm.hidden = !isAvailable || user !== null;
      signOutButton.hidden = user === null;
      accountStatus.textContent = !isAvailable
        ? 'Accounts are unavailable right now (are you offline?). Your cities are saved in this browser.'
        : user
          ? 'Signed in as ' + user.email + '. Your cities follow you to any device.'
          : 'Sign in to keep your cities in the cloud, or just play — they are saved in this browser either way.';
    }

    /**
     * Copies cities from the account into this browser's slots. A slot is
     * overwritten without asking only if it is empty, or already belongs to
     * this account and the account's copy is newer.
     */
    async function pullCitiesFromAccount() {
      const rows = await cloud.loadSlots(user.id);
      rows.forEach(({ slot, data }) => {
        if (!modules.SLOTS.includes(slot) || !data || typeof data !== 'object') return;
        const local = modules.readSlotRaw(slot);
        const isOurs = modules.getSlotOwner(slot) === user.id;
        const isNewer = (Number(data.savedAt) || 0) > (Number(local && local.savedAt) || 0);
        const question =
          'City ' + slot + ': your account has a different city in this slot.\n\n' +
          'OK loads the one from your account. Cancel keeps the one in this browser, which will then replace it.';
        const shouldTake = !local || (isOurs ? isNewer : window.confirm(question));
        if (shouldTake) modules.writeSlotRaw(slot, data);
        modules.setSlotOwner(slot, user.id);
      });
      renderSlots();
    }

    async function setUser(nextUser) {
      user = nextUser;
      renderAccount();
      if (!user) return;
      try {
        await pullCitiesFromAccount();
      } catch (error) {
        console.warn('Could not load cities from the account:', error);
        accountMessage.textContent = modules.describeCloudError(error) + ' Your cities are saved in this browser only.';
      }
    }

    accountForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = emailField.value.trim();
      const password = passwordField.value;
      const isCreating = Boolean(event.submitter) && event.submitter.value === 'signup';
      if (!email.includes('@')) {
        accountMessage.textContent = 'Enter your e-mail address.';
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        accountMessage.textContent = 'The password needs at least ' + MIN_PASSWORD_LENGTH + ' characters.';
        return;
      }
      accountMessage.textContent = isCreating ? 'Creating your account…' : 'Signing in…';
      try {
        const signedInUser = isCreating ? await cloud.signUp(email, password) : await cloud.signIn(email, password);
        passwordField.value = '';
        accountMessage.textContent = signedInUser
          ? ''
          : 'Account created. Open the link in the e-mail we sent you, then sign in here.';
        if (signedInUser) await setUser(signedInUser);
      } catch (error) {
        accountMessage.textContent = error.message;
      }
    });

    signOutButton.addEventListener('click', async () => {
      try {
        await cloud.signOut();
        accountMessage.textContent = '';
        await setUser(null);
      } catch (error) {
        accountMessage.textContent = error.message;
      }
    });

    // ----- opening the menu

    function openMenu() {
      const state = store.getState();
      if (state.slot !== null) modules.saveSlot(state.slot, state);
      store.update(actions.exitToMenu());
      document.body.classList.add('is-in-menu');
      showHome();
    }

    requireElement('menu-button').addEventListener('click', openMenu);
    buildChoices(worldForm, modules);
    renderAccount();
    openMenu();
    if (cloud.isEnabled) {
      cloud.currentUser().then(setUser).catch((error) => console.warn('Could not check the signed-in account:', error));
    }

    return { getUser: () => user };
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, { startMenu });
})();
