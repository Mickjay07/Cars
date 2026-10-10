/*
 * Road Game Builder — accounts and cloud saves.
 *
 * A player can sign in with an e-mail address and password. While signed in,
 * their city is uploaded to the database every so often, and signing in on
 * another browser loads it there. Accounts and storage are a Supabase project
 * (see supabase-setup.sql); each player can reach only their own city.
 *
 * Signing in is optional. Signed out, or with the cloud unreachable, the game
 * carries on saving in the browser alone.
 *
 * Passwords are handed straight to the Supabase library and never stored here.
 */
(function () {
  'use strict';

  const UPLOAD_INTERVAL_MS = 30000;
  const CITY_TABLE = 'cities';
  const MIN_PASSWORD_LENGTH = 6; // Supabase's own minimum
  const SAVED_PARTS = Object.freeze(['roads', 'houses', 'shops', 'parks', 'junctions', 'city']);

  function createCloud({ supabaseUrl, supabaseKey } = {}) {
    const library = window.supabase; // loaded from a CDN by index.html; absent when offline
    const isEnabled = Boolean(supabaseUrl && supabaseKey && library && typeof library.createClient === 'function');
    if (!isEnabled) return { isEnabled };

    const client = library.createClient(supabaseUrl, supabaseKey);
    const unwrap = ({ data, error }) => {
      if (error) throw new Error(error.message);
      return data;
    };

    return {
      isEnabled,
      /** The player already signed in on this browser, or null. */
      async currentUser() {
        const { session } = unwrap(await client.auth.getSession());
        return session ? session.user : null;
      },
      async signIn(email, password) {
        return unwrap(await client.auth.signInWithPassword({ email, password })).user;
      },
      /** Creates an account. Resolves to the new user, or null if they must confirm their e-mail first. */
      async signUp(email, password) {
        const { session } = unwrap(await client.auth.signUp({ email, password }));
        return session ? session.user : null;
      },
      async signOut() {
        unwrap(await client.auth.signOut());
      },
      async save(userId, snapshot) {
        const row = { user_id: userId, data: snapshot, updated_at: new Date().toISOString() };
        unwrap(await client.from(CITY_TABLE).upsert(row));
      },
      /** The player's saved city data, or null if they have none yet. */
      async load(userId) {
        const row = unwrap(await client.from(CITY_TABLE).select('data').eq('user_id', userId).maybeSingle());
        return row ? row.data : null;
      },
    };
  }

  function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing page element: #' + id);
    return element;
  }

  /**
   * Wires up the account controls in the City panel and keeps the city in step with the cloud.
   * `restore(map)` is the store action that swaps in a loaded city, `serialize` and
   * `parse` convert between game state and saved data, and `localSavedAt` is when
   * the save in this browser was written (0 if there is none).
   */
  function startCloudSync({ cloud, store, restore, serialize, parse, localSavedAt }) {
    const status = requireElement('cloud-status');
    const accountButton = requireElement('account-button');
    const dialog = requireElement('account-dialog');
    const form = requireElement('account-form');
    const emailField = requireElement('account-email');
    const passwordField = requireElement('account-password');
    const formMessage = requireElement('account-message');
    const show = (text) => { status.textContent = text; };

    if (!cloud.isEnabled || typeof dialog.showModal !== 'function') {
      show('Unavailable — saving in this browser only.');
      accountButton.disabled = true;
      return;
    }

    let user = null;
    let uploadedState = null; // the state most recently known to match the cloud
    let isBusy = false;
    const isUploaded = (state) => uploadedState !== null && SAVED_PARTS.every((part) => state[part] === uploadedState[part]);
    const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const reportFailure = (error) => {
      console.warn('Cloud save problem:', error);
      const isTableMissing = /could not find the table/i.test(String(error && error.message));
      const problem = isTableMissing
        ? 'The database is not set up yet (run supabase-setup.sql) — saving in this browser only.'
        : 'Cloud unreachable — saving in this browser only.';
      show((user ? 'Signed in as ' + user.email + '. ' : '') + problem);
    };

    async function upload() {
      const state = store.getState();
      if (!user || isBusy || isUploaded(state)) return;
      isBusy = true;
      try {
        await cloud.save(user.id, serialize(state));
        uploadedState = state;
        show('Signed in as ' + user.email + '. Saved at ' + clockTime() + '.');
      } catch (error) {
        reportFailure(error);
      } finally {
        isBusy = false;
      }
    }

    /**
     * Brings the account's city into the game. Right after signing in it always
     * wins (the player is asked first if that would replace something they
     * built); on a normal start it wins only if it is newer than the browser's save.
     */
    async function adoptCloudCity(hasJustSignedIn) {
      const parsed = parse(await cloud.load(user.id));
      if (!parsed) return;
      if (!hasJustSignedIn && parsed.savedAt <= localSavedAt) return;
      const hasLocalCity = store.getState().roads.size > 0;
      const question =
        'Load the city saved in your account?\n\nOK replaces the city in this browser. ' +
        'Cancel keeps this one and saves it to your account instead.';
      if (hasJustSignedIn && hasLocalCity && !window.confirm(question)) return;
      const { savedAt, ...map } = parsed;
      store.update(restore(map));
      uploadedState = store.getState();
    }

    async function setUser(nextUser, hasJustSignedIn) {
      user = nextUser;
      uploadedState = null;
      accountButton.textContent = user ? 'Sign out' : 'Sign in';
      if (!user) {
        show('Not signed in — saving in this browser only.');
        return;
      }
      show('Signed in as ' + user.email + '.');
      try {
        await adoptCloudCity(hasJustSignedIn);
      } catch (error) {
        reportFailure(error);
        return;
      }
      await upload();
    }

    accountButton.addEventListener('click', async () => {
      if (!user) {
        formMessage.textContent = '';
        dialog.showModal();
        return;
      }
      try {
        await cloud.signOut();
        await setUser(null, false);
      } catch (error) {
        reportFailure(error);
      }
    });

    requireElement('account-close').addEventListener('click', () => dialog.close());

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = emailField.value.trim();
      const password = passwordField.value;
      const isCreating = Boolean(event.submitter) && event.submitter.value === 'signup';
      if (!email.includes('@')) {
        formMessage.textContent = 'Enter your e-mail address.';
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        formMessage.textContent = 'The password needs at least ' + MIN_PASSWORD_LENGTH + ' characters.';
        return;
      }
      formMessage.textContent = isCreating ? 'Creating your account…' : 'Signing in…';
      try {
        const signedInUser = isCreating ? await cloud.signUp(email, password) : await cloud.signIn(email, password);
        passwordField.value = '';
        if (!signedInUser) {
          formMessage.textContent = 'Account created. Open the link in the e-mail we sent you, then sign in here.';
          return;
        }
        dialog.close();
        await setUser(signedInUser, true);
      } catch (error) {
        formMessage.textContent = error.message;
      }
    });

    cloud
      .currentUser()
      .then((existingUser) => setUser(existingUser, false))
      .catch(reportFailure)
      .then(() => window.setInterval(upload, UPLOAD_INTERVAL_MS));
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, { createCloud, startCloudSync });
})();
