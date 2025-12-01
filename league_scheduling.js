
/**
 * =============================================================
 * LEAGUE SCHEDULING CORE (league_scheduling.js)
 * (UPDATED: Global Persistence & Infinite Game Counter — FIXED)
 * =============================================================
 */

(function () {
  'use strict';

  // GLOBAL SEASON STATE (PERSISTED cross-day)
  let leagueRoundState = {};   // { "League Name": { currentRound: 0 } }
  window.leagueRoundState = leagueRoundState;

  /**
   * Load SEASON PERSISTENCE (never from daily!)
   */
  function loadRoundState() {
    try {
      const global = window.loadGlobalSettings?.() || {};
      leagueRoundState = global.leagueRoundState || {};
      window.leagueRoundState = leagueRoundState;
    } catch (e) {
      console.error("Failed to load league state:", e);
      leagueRoundState = {};
      window.leagueRoundState = leagueRoundState;
    }
  }

  /**
   * Save SEASON PERSISTENCE (never to daily!)
   */
  function saveRoundState() {
    try {
      window.saveGlobalSettings?.("leagueRoundState", leagueRoundState);
    } catch (e) {
      console.error("Failed to save league state:", e);
    }
  }

  /**
   * Standard round-robin generator
   */
  function generateRoundRobin(teamList) {
    if (!teamList || teamList.length < 2) return [];

    const teams = [...teamList];
    let hasBye = false;

    if (teams.length % 2 !== 0) {
      teams.push("BYE");
      hasBye = true;
    }

    const schedule = [];
    const numRounds = teams.length - 1;

    const fixed = teams[0];
    const rotating = teams.slice(1);

    for (let r = 0; r < numRounds; r++) {
      const round = [];
      round.push([fixed, rotating[0]]);

      for (let i = 1; i < teams.length / 2; i++) {
        const t1 = rotating[i];
        const t2 = rotating[rotating.length - i];
        round.push([t1, t2]);
      }

      schedule.push(round);
      rotating.unshift(rotating.pop());
    }

    if (!hasBye) return schedule;

    return schedule.map(round =>
      round.filter(m => m[0] !== "BYE" && m[1] !== "BYE")
    );
  }

  /**
   * === MAIN API ===
   * Get TODAY'S matchups, automatically increments counter.
   */
  function getLeagueMatchups(leagueName, teams) {
    if (!leagueName || !teams || teams.length < 2) return [];

    // ensure season state is loaded
    loadRoundState();

    const state = leagueRoundState[leagueName] || { currentRound: 0 };
    const fullSchedule = generateRoundRobin(teams);

    if (fullSchedule.length === 0) return [];

    // choose today's round using modulo
    const roundIndex = state.currentRound % fullSchedule.length;
    const matchups = fullSchedule[roundIndex];

    // increment absolute counter
    leagueRoundState[leagueName] = { currentRound: state.currentRound + 1 };
    saveRoundState();

    return matchups;
  }

  /**
   * Returns CURRENT absolute game number (Game X)
   */
  function getLeagueCurrentRound(leagueName) {
    const state = leagueRoundState[leagueName];
    const val = state ? state.currentRound : 0;
    return val === 0 ? 1 : val;
  }

  /**
   * Get matchups for **specific round index**
   * without affecting the global season counter.
   */
  function getMatchupsForRound(teams, roundIndex) {
    if (!teams || teams.length < 2) return [];
    const schedule = generateRoundRobin(teams);
    if (schedule.length === 0) return [];

    return schedule[roundIndex % schedule.length] || [];
  }

  // expose API
  window.getLeagueMatchups = getLeagueMatchups;
  window.getLeagueCurrentRound = getLeagueCurrentRound;
  window.getMatchupsForRound = getMatchupsForRound;

  // load season state on script load
  loadRoundState();

})();
