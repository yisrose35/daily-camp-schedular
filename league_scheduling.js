/**
 * =============================================================
 * LEAGUE SCHEDULING CORE (league_scheduling.js)
 * (UPDATED to use calendar.js save/load)
 * (FIX: Now inherits previous day's round state)
 * =============================================================
 */

(function () {
  'use strict';

  var leagueRoundState = {}; // <-- CHANGED TO VAR

  /**
   * Loads the current round for all leagues from the *current day's* data.
   * If today is blank, it *inherits* from yesterday.
   */
  function loadRoundState() {
    try {
      // 1. Try to load THIS day's data (if it has data, use it)
      if (window.currentDailyData && window.currentDailyData.leagueRoundState && Object.keys(window.currentDailyData.leagueRoundState).length > 0) {
        leagueRoundState = window.currentDailyData.leagueRoundState;
      } 
      // 2. If this day is blank, load YESTERDAY'S data
      else if (window.loadPreviousDailyData) {
        console.log("No round state for today. Loading from yesterday.");
        const yesterdayData = window.loadPreviousDailyData();
        leagueRoundState = yesterdayData.leagueRoundState || {};
        
        // IMPORTANT: Save this inherited state to the CURRENT day
        // so if we regenerate today, it doesn't re-use yesterday's state.
        saveRoundState();
      }
      else {
        leagueRoundState = {};
      }
    } catch (e) {
      console.error("Failed to load league state:", e);
      leagueRoundState = {};
    }
  }

  /**
   * Saves the current round for all leagues to the *current day's* data.
   */
  function saveRoundState() {
    try {
      window.saveCurrentDailyData?.("leagueRoundState", leagueRoundState);
    } catch (e) {
      console.error("Failed to save league state:", e);
    }
  }

  /**
   * Generates a full round-robin tournament schedule for a list of teams.
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
  
    const fixedTeam = teams[0];
    const rotatingTeams = teams.slice(1);
  
    for (let round = 0; round < numRounds; round++) {
      const currentRound = [];
      
      currentRound.push([fixedTeam, rotatingTeams[0]]);
  
      for (let i = 1; i < teams.length / 2; i++) {
        const team1 = rotatingTeams[i];
        const team2 = rotatingTeams[rotatingTeams.length - i];
        currentRound.push([team1, team2]);
      }
  
      schedule.push(currentRound);
      rotatingTeams.unshift(rotatingTeams.pop());
    }
  
    if (hasBye) {
      return schedule.map(round => 
        round.filter(match => match[0] !== "BYE" && match[1] !== "BYE")
      );
    }
  
    return schedule;
  }

  /**
   * Public function to get the *next* set of matchups for a league.
   */
  function getLeagueMatchups(leagueName, teams) {
    if (!leagueName || !teams || teams.length < 2) {
      return []; 
    }
  
    loadRoundState();
  
    const state = leagueRoundState[leagueName] || { currentRound: 0 };
    const fullSchedule = generateRoundRobin(teams);
  
    if (fullSchedule.length === 0) {
      return []; 
    }
  
    const todayMatchups = fullSchedule[state.currentRound];
  
    // Increment and save the round number for next time
    const nextRound = (state.currentRound + 1) % fullSchedule.length;
    leagueRoundState[leagueName] = { currentRound: nextRound };
    saveRoundState();
  
    return todayMatchups;
  }

  // --- Global Exposure and Initialization ---
  window.getLeagueMatchups = getLeagueMatchups;
  
  // IMPORTANT: Load state on script execution
  // This will load the state for the current date set by calendar.js
  loadRoundState(); 
  
})();
