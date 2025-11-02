/**
 * =============================================================
 * LEAGUE SCHEDULING CORE (league_scheduling.js)
 * =============================================================
 * This file generates and tracks round-robin matchups for leagues.
 * It uses a stable algorithm to create valid matches for app2.js.
 *
 * Public Functions:
 * - window.getLeagueMatchups(leagueName, teams)
 * =============================================================
 */

(function () {
  'use strict';

  const LEAGUE_STATE_KEY = "camp_league_round_state";
  let leagueRoundState = {}; // { "League Name": { currentRound: 0 } }

  /**
   * Loads the current round for all leagues from localStorage.
   */
  function loadRoundState() {
    try {
      const stored = localStorage.getItem(LEAGUE_STATE_KEY);
      leagueRoundState = stored ? JSON.parse(stored) : {};
    } catch (e) {
      console.error("Failed to load league state:", e);
      leagueRoundState = {};
    }
  }

  /**
   * Saves the current round for all leagues to localStorage.
   */
  function saveRoundState() {
    try {
      localStorage.setItem(LEAGUE_STATE_KEY, JSON.stringify(leagueRoundState));
    } catch (e) {
      console.error("Failed to save league state:", e);
    }
  }

  /**
   * Generates a full round-robin tournament schedule for a list of teams (STABLE VERSION).
   * It uses the Circle Method to create balanced rounds.
   * @param {string[]} teamList - An array of team names.
   * @returns {Array<Array<string[]>>} An array of rounds.
   */
  function generateRoundRobin(teamList) {
    if (!teamList || teamList.length < 2) {
      return [];
    }

    const teams = [...teamList];
    let hasBye = false;
    if (teams.length % 2 !== 0) {
      teams.push("BYE");
      hasBye = true;
    }

    const numRounds = teams.length - 1;
    const schedule = [];

    // Separate the stationary team (teams[0]) and the rotating teams (teams[1] onward)
    const fixedTeam = teams[0];
    const rotatingTeams = teams.slice(1);

    for (let round = 0; round < numRounds; round++) {
      const currentRound = [];
      
      // 1. Pair the fixed team with the first rotating team
      currentRound.push([fixedTeam, rotatingTeams[0]]);

      // 2. Pair the remaining teams (using the "Circle Method")
      // Loop runs up to half the total teams (excluding the fixed one)
      for (let i = 1; i < teams.length / 2; i++) {
        const team1 = rotatingTeams[i];
        const team2 = rotatingTeams[rotatingTeams.length - i];
        currentRound.push([team1, team2]);
      }

      schedule.push(currentRound);

      // 3. Rotate the rotatingTeams array: last element moves to the front
      rotatingTeams.unshift(rotatingTeams.pop());
    }

    // Filter out any "BYE" games from the final schedule
    if (hasBye) {
      return schedule.map(round => 
        round.filter(match => match[0] !== "BYE" && match[1] !== "BYE")
      );
    }

    return schedule;
  }

  /**
   * Public function to get the *next* set of matchups for a league.
   * This function manages the current round state.
   * @param {string} leagueName - The unique name of the league.
   * @param {string[]} teams - The list of team names participating in the league.
   * @returns {Array<string[]>} An array of matchups for the current round.
   */
  function getLeagueMatchups(leagueName, teams) {
    if (!leagueName || !teams || teams.length < 2) {
      return []; 
    }

    loadRoundState();

    const state = leagueRoundState[leagueName] || { currentRound: 0 };
    const fullSchedule = generateRoundRobin(teams);

    if (fullSchedule.length === 0) {
      // Should not happen if teams.length >= 2, but remains a safety check.
      return []; 
    }

    // Get the matchups for today using the current round index
    const todayMatchups = fullSchedule[state.currentRound];

    // Increment and save the round number for next time
    const nextRound = (state.currentRound + 1) % fullSchedule.length;
    leagueRoundState[leagueName] = { currentRound: nextRound };
    saveRoundState();

    return todayMatchups;
  }

  // --- Global Exposure and Initialization ---
  window.getLeagueMatchups = getLeagueMatchups;

  // IMPORTANT: Load state on script execution.
  loadRoundState(); 

})();
