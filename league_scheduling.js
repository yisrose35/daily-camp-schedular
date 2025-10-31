/**
 * =============================================================
 * LEAGUE SCHEDULING CORE (league_scheduling.js)
 * =============================================================
 * This file generates and tracks round-robin matchups for leagues.
 * It is called by the main scheduler (app2.js) when it needs to
 * schedule a league game.
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
   * Generates a full round-robin tournament schedule for a list of teams.
   * @param {string[]} teamList - An array of team names.
   * @returns {Array<Array<string[]>>} An array of rounds, e.g.,
   * [
   * [ ['A', 'B'], ['C', 'D'] ], // Round 1
   * [ ['A', 'C'], ['B', 'D'] ]  // Round 2
   * ]
   */
  function generateRoundRobin(teamList) {
    if (!teamList || teamList.length < 2) {
      return [];
    }

    // Clone the list and add a "BYE" if there's an odd number of teams
    const teams = [...teamList];
    let hasBye = false;
    if (teams.length % 2 !== 0) {
      teams.push("BYE");
      hasBye = true;
    }

    const numRounds = teams.length - 1;
    const numMatchesPerRound = teams.length / 2;
    const schedule = [];

    // Create a fixed array (team 0 is stationary) and a rotating array
    const fixedTeam = teams[0];
    const rotatingTeams = teams.slice(1);

    for (let round = 0; round < numRounds; round++) {
      const currentRound = [];
      
      // Pair the fixed team with the first team in the rotating list
      const firstMatch = [fixedTeam, rotatingTeams[0]];
      currentRound.push(firstMatch);

      // Pair the rest of the teams
      for (let i = 1; i < numMatchesPerRound; i++) {
        const team1 = rotatingTeams[i];
        const team2 = rotatingTeams[rotatingTeams.length - i];
        currentRound.push([team1, team2]);
      }

      // Add this round to the schedule
      schedule.push(currentRound);

      // Rotate the rotatingTeams array (move the last element to the first position)
      rotatingTeams.unshift(rotatingTeams.pop());
    }

    // Filter out any "BYE" games from the final schedule
    if (hasBye) {
      const filteredSchedule = [];
      for (const round of schedule) {
        const filteredRound = round.filter(match => 
          match[0] !== "BYE" && match[1] !== "BYE"
        );
        filteredSchedule.push(filteredRound);
      }
      return filteredSchedule;
    }

    return schedule;
  }

  /**
   * Public function to get the *next* set of matchups for a league.
   * This function has side effects: it updates and saves the league's current round.
   * @param {string} leagueName - The unique name of the league (e.g., "Senior League").
   * @param {string[]} teams - The list of team names participating in the league.
   * @returns {Array<string[]>} An array of matchups for the current round, e.g., [['A', 'B'], ['C', 'D']]
   */
  function getLeagueMatchups(leagueName, teams) {
    if (!leagueName || !teams || teams.length < 2) {
      return []; // Not enough teams to play
    }

    loadRoundState();

    const state = leagueRoundState[leagueName] || { currentRound: 0 };
    const fullSchedule = generateRoundRobin(teams);

    if (fullSchedule.length === 0) {
      return []; // No schedule could be generated
    }

    // Get the matchups for today
    const todayMatchups = fullSchedule[state.currentRound];

    // Increment and save the round number for next time
    const nextRound = (state.currentRound + 1) % fullSchedule.length;
    leagueRoundState[leagueName] = { currentRound: nextRound };
    saveRoundState();

    return todayMatchups;
  }

  // --- Global Exposure ---
  window.getLeagueMatchups = getLeagueMatchups;

})();
