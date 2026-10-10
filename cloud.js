/*
 * Road Game Builder — accounts and cloud saves.
 *
 * A player can sign in with an e-mail address and password (on the welcome
 * screen, see menu.js). While they are signed in, the city being played is
 * uploaded to their account every so often. Accounts and storage are a
 * Supabase project (see supabase-setup.sql); each player can reach only
 * their own cities.
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
      async saveSlot(userId, slot, snapshot) {
        const row = { user_id: userId, slot, data: snapshot, updated_at: new Date().toISOString() };
        unwrap(await client.from(CITY_TABLE).upsert(row, { onConflict: 'user_id,slot' }));
      },
      /** Every city saved in the account, as [{ slot, data }]. */
      async loadSlots(userId) {
        return unwrap(await client.from(CITY_TABLE).select('slot, data').eq('user_id', userId)) || [];
      },
    };
  }

  /** Turns a database error into something a player can act on. */
  function describeCloudError(error) {
    const message = String(error && error.message);
    if (/could not find the table|column .* does not exist|no unique or exclusion constraint/i.test(message)) {
      return 'The database is not set up for this version yet (run supabase-setup.sql).';
    }
    return 'The cloud cannot be reached.';
  }

  /**
   * While a city is being played and a player is signed in, uploads it every so often.
   * `getUser()` returns the signed-in user or null, `serialize` turns the game state
   * into saved data and `markOwned(slot, userId)` records that a slot belongs to an account.
   */
  function startCloudUpload({ cloud, store, serialize, getUser, markOwned, savedParts }) {
    const status = document.getElementById('cloud-status');
    if (!status) throw new Error('Missing page element: #cloud-status');
    const show = (text) => { status.textContent = text; };
    if (!cloud.isEnabled) {
      show('Accounts are unavailable. Saving in this browser only.');
      return;
    }

    let uploaded = null; // { slot, state } most recently known to match the cloud
    let isBusy = false;
    const isUploaded = (state) =>
      uploaded !== null && uploaded.slot === state.slot && savedParts.every((part) => state[part] === uploaded.state[part]);
    const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    async function upload() {
      const state = store.getState();
      const user = getUser();
      if (!user) {
        show('Not signed in. Saving in this browser only.');
        return;
      }
      if (state.slot === null || isBusy || isUploaded(state)) return;
      isBusy = true;
      try {
        await cloud.saveSlot(user.id, state.slot, serialize(state));
        markOwned(state.slot, user.id);
        uploaded = { slot: state.slot, state };
        show('Signed in as ' + user.email + '. Saved to your account at ' + clockTime() + '.');
      } catch (error) {
        console.warn('Cloud save problem:', error);
        show('Signed in as ' + user.email + '. ' + describeCloudError(error) + ' Saving in this browser only.');
      } finally {
        isBusy = false;
      }
    }

    window.setInterval(upload, UPLOAD_INTERVAL_MS);
    return { uploadNow: upload };
  }

  window.RoadGameModules = Object.assign(window.RoadGameModules || {}, { createCloud, startCloudUpload, describeCloudError });
})();
