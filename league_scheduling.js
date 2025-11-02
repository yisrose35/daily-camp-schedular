/**
   * Public function to get the *next* set of matchups for a league (DEBUG VERSION).
   */
  function getLeagueMatchups(leagueName, teams) {
    if (!teams || teams.length < 2) {
      console.warn(`[DIAGNOSTIC] League ${leagueName} skipped: Teams list is too short.`);
      return []; 
    }
    
    // --- TEMPORARY HARDCODED RETURN ---
    // This bypasses round-robin, state saving, and rotation entirely.
    // It guarantees one match for the first two teams.
    console.log(`[DIAGNOSTIC] Assigning hardcoded match for ${leagueName}.`);

    // Ensure we always save the state so the round number is incremented, 
    // simulating a successful day (even though the schedule is fake).
    loadRoundState();
    const state = leagueRoundState[leagueName] || { currentRound: 0 };
    const nextRound = (state.currentRound + 1) % 5; // Use a fixed arbitrary number (5)
    leagueRoundState[leagueName] = { currentRound: nextRound };
    saveRoundState();

    return [
      [teams[0], teams[1]]
    ];
    // ---------------------------------
  }
