// ======================================================================
// league_scheduling.js — ULTIMATE ROTATION ENGINE (Nov 2025)
// Fully compatible with your new scheduler_logic_core.js
// ======================================================================

(function () {
    'use strict';

    // ================================================
    // ROUND STATE (per-league per-day)
    // ================================================
    let leagueRoundState = {}; // { "League Name": { currentRound: number } }
    window.leagueRoundState = leagueRoundState;

    // -----------------------------------------
    // Load round state from the *current day*
    // -----------------------------------------
    function loadRoundState() {
        try {
            if (window.currentDailyData && window.currentDailyData.leagueRoundState) {
                leagueRoundState = window.currentDailyData.leagueRoundState;
            } else if (window.loadCurrentDailyData) {
                const data = window.loadCurrentDailyData() || {};
                leagueRoundState = data.leagueRoundState || {};
            } else {
                leagueRoundState = {};
            }
        } catch (e) {
            console.error("League Round State load failed:", e);
            leagueRoundState = {};
        }
        window.leagueRoundState = leagueRoundState;
    }

    // -----------------------------------------
    // Save round state into *today's* data
    // -----------------------------------------
    function saveRoundState() {
        try {
            if (window.saveCurrentDailyData) {
                const data = window.loadCurrentDailyData() || {};
                data.leagueRoundState = leagueRoundState;
                window.saveCurrentDailyData(data);
            }
        } catch (e) {
            console.error("League Round State save failed:", e);
        }
    }

    // ================================================
    // PERFECT ROUND ROBIN GENERATOR
    // ================================================
    function generateRoundRobin(teamList) {
        if (!teamList || teamList.length < 2) return [];

        const teams = [...teamList];
        let addedBye = false;

        // Add BYE if odd number
        if (teams.length % 2 !== 0) {
            teams.push("BYE");
            addedBye = true;
        }

        const n = teams.length;
        const fixed = teams[0];
        const rot = teams.slice(1);
        const rounds = n - 1;

        const schedule = [];

        for (let r = 0; r < rounds; r++) {
            const round = [];

            // first pairing is fixed vs first rotating
            round.push([fixed, rot[0]]);

            // remaining pairings
            for (let i = 1; i < n / 2; i++) {
                const t1 = rot[i];
                const t2 = rot[rot.length - i];
                round.push([t1, t2]);
            }

            // advance rotation
            rot.unshift(rot.pop());
            schedule.push(round);
        }

        // Remove BYE matchups
        if (addedBye) {
            return schedule.map(round =>
                round.filter(([A, B]) => A !== "BYE" && B !== "BYE")
            );
        }

        return schedule;
    }

    // ================================================================
    // ULTIMATE PERFECT ROTATION (FIXED VERSION)
    // ================================================================
    window.generateUltimateLeagueRotation = function (
        leagueName,
        teams,
        sports,
        fieldsBySport,
        blockConfig
    ) {
        // 1) Build RR
        const rr = generateRoundRobin(teams);
        if (!rr || rr.length === 0) return [];

        const games = [];
        let roundNum = 1;

        // 2) ONE SPORT PER ROUND (perfect rotation)
        for (let i = 0; i < rr.length; i++) {
            const round = rr[i];
            const sport = sports[i % sports.length]; // cycling perfectly

            const availableFields = fieldsBySport[sport] || ["Field A"];
            let fieldIndex = 0;

            // 3) Add matchups for this round
            for (const match of round) {
                const [A, B] = match;

                // skip invalid matchups
                if (!A || !B || A === B) continue;

                games.push({
                    round: roundNum,
                    teamA: A,
                    teamB: B,
                    sport: sport,
                    field: availableFields[fieldIndex % availableFields.length]
                });

                fieldIndex++;
            }

            roundNum++;
        }

        return games;
    };

    // ================================================================
    // GET MATCHUPS (advances round correctly)
    // ================================================================
    window.getLeagueMatchups = function (leagueName, teams) {
        if (!leagueName || !teams || teams.length < 2) return [];

        // Load state only once per day — NOT per optimizer cycle
        const state = leagueRoundState[leagueName] || { currentRound: 0 };

        const rr = generateRoundRobin(teams);
        if (rr.length === 0) return [];

        const todaysMatches = rr[state.currentRound];

        // Advance round
        state.currentRound = (state.currentRound + 1) % rr.length;
        leagueRoundState[leagueName] = state;

        saveRoundState();

        return todaysMatches;
    };

    // ================================================================
    // INIT
    // ================================================================
    loadRoundState();

})();
