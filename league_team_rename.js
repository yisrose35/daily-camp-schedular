/**
 * league_team_rename.js — TEAM IDENTITY ACROSS A RENAME
 * =============================================================================
 * Team identity in this codebase IS the team's name string. `league.teams` is an
 * array of names; standings, results, matchup history, sport history, away-trip
 * counters, chinuch attendance, playoff brackets and the saved daily schedules
 * all key off that same string.
 *
 * That breaks the real-world flow camps actually use: a league starts with
 * placeholder names ("Team 1" … "Team 18"), and by game 2 the campers have
 * picked real names ("The Pancakes", "The Waffles"). Deleting "Team 1" and
 * adding "The Pancakes" made the program treat them as two unrelated teams —
 * so the record of "Team 1 already played Team 2 at basketball" was stranded on
 * a team that no longer existed, matchup/sport variety generated blind, and
 * standings started over.
 *
 * This module makes a rename a FIRST-CLASS operation with two halves:
 *
 *   1. MIGRATION (eager) — every stored occurrence of the old name is rewritten
 *      to the new one: league config (teams / standings / results / playoff /
 *      chinuch facilities / conferences), the league history blob, and the saved
 *      daily schedules for every date.
 *
 *   2. ALIASES (lazy safety net) — the rename is recorded on the league as
 *      `teamAliases: { "<former name>": "<current name>" }`, and the read paths
 *      resolve through it. Migration alone is not enough: another device can
 *      still push a league-history lineage written BEFORE the rename (the LG-8
 *      merge unions them by (league, date), so old-name games come back), and
 *      the LG-9 reconcile can rebuild a day from a saved schedule that never
 *      got migrated. With the alias map, those old-name records fold into the
 *      current team instead of forking a phantom one.
 *
 * Alias rules that keep this safe:
 *   • a LIVE team name is never treated as an alias — so re-creating a team
 *     called "Team 1" after "Team 1" → "The Pancakes" gives a genuinely new
 *     team, not a second door into the Pancakes' record,
 *   • rename chains collapse (Team 1 → Pancakes → Flapjacks leaves BOTH
 *     "Team 1" and "Pancakes" pointing at "Flapjacks"), so there is no chain to
 *     walk at read time and no cycle to guard against,
 *   • aliases whose target no longer exists (team later deleted) are ignored.
 *
 * Shared by regular leagues (leagues.js / scheduler_core_leagues.js) and
 * specialty leagues (specialty_leagues.js / scheduler_core_specialty_leagues.js)
 * — the two stores differ, the identity problem does not.
 */
(function () {
    'use strict';

    const LTR = {};

    // Placeholders that appear in matchup slots but are not teams.
    const RESERVED = new Set(['bye', 'tbd', '']);

    // =========================================================================
    // NAME COMPARISON
    // =========================================================================
    // Names are compared case- and whitespace-insensitively so "the pancakes"
    // resolves to "The Pancakes": the stored strings come from free-text input
    // and from string-parsed schedule lines, where case/spacing drift is common.
    function normKey(name) {
        return String(name == null ? '' : name).trim().toLowerCase();
    }
    function sameName(a, b) {
        const ka = normKey(a);
        return ka !== '' && ka === normKey(b);
    }
    LTR.normKey = normKey;
    LTR.sameName = sameName;

    function isRealTeamName(name) {
        return !RESERVED.has(normKey(name));
    }

    // =========================================================================
    // ALIAS MAP
    // =========================================================================
    /** normKey(former name) → current live team name. Aliases that collide with
     *  a live team, or that point at a team which no longer exists, are dropped. */
    function aliasMap(league) {
        const out = new Map();
        if (!league) return out;
        const live = new Map();
        (league.teams || []).forEach(function (t) {
            if (t) live.set(normKey(t), t);
        });
        const raw = (league.teamAliases && typeof league.teamAliases === 'object') ? league.teamAliases : null;
        if (!raw) return out;
        Object.keys(raw).forEach(function (former) {
            const nk = normKey(former);
            if (!nk || !isRealTeamName(former)) return;
            if (live.has(nk)) return;                      // a live team is nobody's alias
            const target = raw[former];
            if (typeof target !== 'string') return;
            const liveTarget = live.get(normKey(target));
            if (!liveTarget) return;                       // target team was deleted
            out.set(nk, liveTarget);
        });
        return out;
    }
    LTR.aliasMap = aliasMap;

    LTR.hasAliases = function (league) {
        return aliasMap(league).size > 0;
    };

    /** Resolve a possibly-former name to the team's current name. */
    function canonicalName(league, name) {
        if (!league || name == null) return name;
        const nk = normKey(name);
        if (!nk || !isRealTeamName(name)) return name;
        const teams = league.teams || [];
        for (let i = 0; i < teams.length; i++) {
            if (normKey(teams[i]) === nk) return teams[i];
        }
        const al = aliasMap(league);
        return al.has(nk) ? al.get(nk) : name;
    }
    LTR.canonicalName = canonicalName;

    /** Pre-built resolver for hot loops (history folding, per-date sweeps).
     *  Returns a `(name) => name` identity function when the league has no
     *  aliases, so callers can skip work entirely. */
    function resolverFor(league) {
        const al = aliasMap(league);
        if (!al.size) return null;
        const live = new Set();
        (league.teams || []).forEach(function (t) { if (t) live.add(normKey(t)); });
        return function (name) {
            const nk = normKey(name);
            if (!nk || !isRealTeamName(name) || live.has(nk)) return name;
            return al.has(nk) ? al.get(nk) : name;
        };
    }
    LTR.resolverFor = resolverFor;

    /** Record `oldName → newName`, collapsing any chain that already ended at
     *  oldName so the map never needs to be walked transitively. */
    function recordAlias(league, oldName, newName) {
        if (!league || !isRealTeamName(oldName) || !isRealTeamName(newName)) return;
        if (sameName(oldName, newName)) return;
        if (!league.teamAliases || typeof league.teamAliases !== 'object') league.teamAliases = {};
        const al = league.teamAliases;
        Object.keys(al).forEach(function (k) {
            // Chain collapse: "Team 1" → "Pancakes" becomes "Team 1" → "Flapjacks".
            if (sameName(al[k], oldName)) al[k] = newName;
            // The new name must not simultaneously be an alias for something else.
            if (sameName(k, newName)) delete al[k];
        });
        al[oldName] = newName;
    }
    LTR.recordAlias = recordAlias;

    /** Drop any alias claiming `name`, so a team CREATED with a previously-used
     *  name starts with a clean record instead of inheriting the old team's. */
    function dropAliasFor(league, name) {
        if (!league || !league.teamAliases || !isRealTeamName(name)) return false;
        let dropped = false;
        Object.keys(league.teamAliases).forEach(function (k) {
            if (sameName(k, name)) { delete league.teamAliases[k]; dropped = true; }
        });
        if (dropped && Object.keys(league.teamAliases).length === 0) delete league.teamAliases;
        return dropped;
    }
    LTR.dropAliasFor = dropAliasFor;

    // =========================================================================
    // MATCHUP DISPLAY STRINGS
    // =========================================================================
    // Regular-league games are stored in the saved schedules as display lines,
    // so a rename has to rewrite them. A blind string replace is wrong — a team
    // called "Red" would corrupt "@ Red Field" and "(Red Ball)" — so each line
    // is parsed into its team slots and only those are swapped.
    //
    //   "<A> vs <B> @ <field> (<sport>)"   ← a game (the "@ …" tail is optional)
    //   "<T> — Bye"                        ← unpaired team
    //   "<T> — Chinuch (<facility>)"       ← team at chinuch instead of a game
    //   "<T>"                              ← bare name
    const VS_LINE = /^(\s*)(.+?)(\s+vs\.?\s+)([^@]+?)(\s+@\s+.*)?$/i;
    const SOLO_LINE = /^(\s*)([^—]+?)(\s+—\s+.*)$/;   // em-dash separated

    /** Rewrite the team slots of one matchup line. `map` is (name) => name. */
    function rewriteMatchupLine(line, map) {
        if (typeof line !== 'string') return line;
        const vs = line.match(VS_LINE);
        if (vs) {
            const a = vs[2].trim(), b = vs[4].trim();
            const na = map(a), nb = map(b);
            if (na === a && nb === b) return line;
            return vs[1] + na + vs[3] + nb + (vs[5] || '');
        }
        const solo = line.match(SOLO_LINE);
        if (solo) {
            const t = solo[2].trim();
            const nt = map(t);
            return nt === t ? line : (solo[1] + nt + solo[3]);
        }
        const bare = line.trim();
        if (!bare) return line;
        const nb2 = map(bare);
        return nb2 === bare ? line : line.replace(bare, nb2);
    }
    LTR.rewriteMatchupLine = rewriteMatchupLine;

    /** Rewrite one entry of a `matchups` / `_allMatchups` array. Regular leagues
     *  store display strings, specialty leagues store {teamA, teamB, …} objects;
     *  both shapes turn up in `leagueAssignments`, so handle either. */
    function rewriteMatchupEntry(m, map) {
        if (typeof m === 'string') {
            const next = rewriteMatchupLine(m, map);
            return { value: next, changed: next !== m };
        }
        if (m && typeof m === 'object') {
            let changed = false;
            ['teamA', 'teamB', 'team1', 'team2', 'winner'].forEach(function (k) {
                if (typeof m[k] !== 'string') return;
                const next = map(m[k]);
                if (next !== m[k]) { m[k] = next; changed = true; }
            });
            return { value: m, changed: changed };
        }
        return { value: m, changed: false };
    }
    LTR.rewriteMatchupEntry = rewriteMatchupEntry;

    /** Rewrite an array of matchups in place. Returns the number changed. */
    function rewriteMatchupList(list, map) {
        if (!Array.isArray(list)) return 0;
        let n = 0;
        for (let i = 0; i < list.length; i++) {
            const r = rewriteMatchupEntry(list[i], map);
            if (r.changed) { list[i] = r.value; n++; }
        }
        return n;
    }
    LTR.rewriteMatchupList = rewriteMatchupList;

    // =========================================================================
    // OBJECT-KEY REWRITING
    // =========================================================================
    /** Move `obj[oldName]` to `obj[newName]`, merging via `mergeFn` when the
     *  destination already exists (both names carrying data — possible when a
     *  stale device wrote under the old name after the rename). */
    function renameObjectKey(obj, oldName, newName, mergeFn) {
        if (!obj || typeof obj !== 'object') return false;
        let changed = false;
        Object.keys(obj).forEach(function (k) {
            if (!sameName(k, oldName)) return;
            const incoming = obj[k];
            delete obj[k];
            if (obj[newName] !== undefined && typeof mergeFn === 'function') {
                obj[newName] = mergeFn(obj[newName], incoming);
            } else if (obj[newName] === undefined) {
                obj[newName] = incoming;
            }
            changed = true;
        });
        return changed;
    }
    LTR.renameObjectKey = renameObjectKey;

    /** Rewrite every string element of an array of team names in place. */
    function renameInNameArray(arr, oldName, newName) {
        if (!Array.isArray(arr)) return 0;
        let n = 0;
        for (let i = 0; i < arr.length; i++) {
            if (typeof arr[i] === 'string' && sameName(arr[i], oldName)) { arr[i] = newName; n++; }
        }
        return n;
    }
    LTR.renameInNameArray = renameInNameArray;

    // =========================================================================
    // LEAGUE CONFIG MIGRATION
    // =========================================================================
    /**
     * Rewrite every team-name reference inside a league config object. Shared by
     * regular and specialty leagues — each store only has the sub-objects it
     * uses, and absent ones are simply skipped.
     *
     * Returns a summary of what moved (used for the console/UI report).
     */
    function applyToLeagueConfig(league, oldName, newName) {
        const out = { teams: 0, standings: false, h2h: false, games: 0, playoff: 0, chinuch: false, byeActivity: false, conferences: 0 };
        if (!league) return out;

        // teams — rewritten IN PLACE so roster order (and therefore the
        // round-robin fallback pairing) is unchanged by a rename.
        out.teams = renameInNameArray(league.teams, oldName, newName);

        // standings — keep the accumulated W/L/T under the new name. When both
        // names somehow carry a row, sum them rather than dropping one.
        out.standings = renameObjectKey(league.standings, oldName, newName, function (dst, src) {
            const merged = Object.assign({}, src, dst);
            ['w', 'l', 't', 'pf', 'pa'].forEach(function (f) {
                const a = parseInt(dst && dst[f], 10) || 0;
                const b = parseInt(src && src[f], 10) || 0;
                if (a || b) merged[f] = a + b;
            });
            if (merged.pf != null || merged.pa != null) {
                merged.diff = (parseInt(merged.pf, 10) || 0) - (parseInt(merged.pa, 10) || 0);
            }
            return merged;
        });

        // _h2h is a transient derived table (stripped before persisting and
        // rebuilt by recalcStandings) — drop it rather than migrate it.
        if (league._h2h) { delete league._h2h; out.h2h = true; }

        // Results archive: league.games[].matches[] — the entered scores are the
        // reason a rename must not restart the season.
        (Array.isArray(league.games) ? league.games : []).forEach(function (g) {
            if (!g) return;
            (Array.isArray(g.matches) ? g.matches : []).forEach(function (m) {
                if (!m) return;
                ['teamA', 'teamB', 'team1', 'team2', 'winner'].forEach(function (k) {
                    if (typeof m[k] === 'string' && sameName(m[k], oldName)) { m[k] = newName; out.games++; }
                });
            });
        });

        // Playoff bracket — matchups, winners and byes per round.
        const rounds = (league.playoff && Array.isArray(league.playoff.rounds)) ? league.playoff.rounds : [];
        rounds.forEach(function (r) {
            if (!r) return;
            (Array.isArray(r.matchups) ? r.matchups : []).forEach(function (m) {
                if (!m) return;
                ['teamA', 'teamB', 'winner'].forEach(function (k) {
                    if (typeof m[k] === 'string' && sameName(m[k], oldName)) { m[k] = newName; out.playoff++; }
                });
            });
            out.playoff += renameInNameArray(r.byes, oldName, newName);
        });

        // Chinuch facility assignment is keyed by team.
        if (league.chinuch && league.chinuch.bunkFacilities) {
            out.chinuch = renameObjectKey(league.chinuch.bunkFacilities, oldName, newName);
        }

        // Bye-activity pins are keyed by team too, so a rename must carry them.
        if (league.byeActivity && league.byeActivity.teamActivities) {
            out.byeActivity = renameObjectKey(league.byeActivity.teamActivities, oldName, newName);
        }

        // Conferences: written as {name: [teams]} by the scheduler and as an
        // array by the specialty validator — walk either shape.
        const conf = league.conferences;
        if (Array.isArray(conf)) {
            conf.forEach(function (c) {
                if (Array.isArray(c)) out.conferences += renameInNameArray(c, oldName, newName);
                else if (c && Array.isArray(c.teams)) out.conferences += renameInNameArray(c.teams, oldName, newName);
            });
        } else if (conf && typeof conf === 'object') {
            Object.keys(conf).forEach(function (k) {
                if (Array.isArray(conf[k])) out.conferences += renameInNameArray(conf[k], oldName, newName);
            });
        }

        return out;
    }
    LTR.applyToLeagueConfig = applyToLeagueConfig;

    // =========================================================================
    // SAVED DAILY SCHEDULES MIGRATION
    // =========================================================================
    /**
     * Rewrite the old name across every saved date, in both stores that hold
     * league matchups:
     *
     *   • dailyData[date].leagueAssignments[division][slot].matchups  — the
     *     division-level table the calendar/print/validator read, and the
     *     ground truth the LG-9 reconcile rebuilds lost history from,
     *   • dailyData[date].scheduleAssignments[bunk][slot]._allMatchups — the
     *     per-bunk copy the grid renders.
     *
     * Only entries belonging to `leagueName` are touched, so two leagues with a
     * same-named team stay independent. Changed dates are persisted through the
     * verified per-date schedule path (the same one generation uses), because
     * daily_schedules is written per date, not as one blob.
     *
     * `leagueName` may be a single name or an array (a specialty league's
     * history is keyed by id while its schedule rows are keyed by name).
     */
    /** Rewrite the division-level league table (leagueAssignments-shaped). */
    function rewriteLeagueAssignments(la, ownsLeague, map) {
        if (!la || typeof la !== 'object') return 0;
        let n = 0;
        Object.keys(la).forEach(function (div) {
            const slots = la[div];
            if (!slots || typeof slots !== 'object') return;
            Object.keys(slots).forEach(function (slot) {
                const entry = slots[slot];
                if (!entry || typeof entry !== 'object') return;
                if (!ownsLeague(entry.leagueName || '', entry)) return;
                n += rewriteMatchupList(entry.matchups, map);
                n += rewriteMatchupList(entry._allMatchups, map);
            });
        });
        return n;
    }
    LTR.rewriteLeagueAssignments = rewriteLeagueAssignments;

    /** Rewrite the per-bunk grid copy (scheduleAssignments-shaped). Rows are
     *  arrays in the auto builder and slot-keyed objects in the manual builder;
     *  Object.keys handles both. */
    function rewriteScheduleAssignments(sa, ownsLeague, map) {
        if (!sa || typeof sa !== 'object') return 0;
        let n = 0;
        Object.keys(sa).forEach(function (bunk) {
            const row = sa[bunk];
            if (!row || typeof row !== 'object') return;
            Object.keys(row).forEach(function (slot) {
                const entry = row[slot];
                if (!entry || typeof entry !== 'object') return;
                if (!ownsLeague(entry._leagueName || '', entry)) return;
                n += rewriteMatchupList(entry._allMatchups, map);
                n += rewriteMatchupList(entry.matchups, map);
            });
        });
        return n;
    }
    LTR.rewriteScheduleAssignments = rewriteScheduleAssignments;

    function applyToDailySchedules(leagueName, oldName, newName) {
        const res = { dates: [], entries: 0, live: 0, ok: false, reason: null };
        try {
            if (typeof window === 'undefined' || typeof window.loadAllDailyData !== 'function') {
                res.reason = 'no daily-data API';
                return res;
            }
            const names = (Array.isArray(leagueName) ? leagueName : [leagueName])
                .filter(function (n) { return typeof n === 'string' && n; });
            if (!names.length) { res.reason = 'no league name'; return res; }

            // A league slot identifies its league by _leagueName / leagueName, or
            // — for per-bunk entries written by the solver — by the
            // "League: <name>" activity label.
            const ownsLeague = function (declared, entry) {
                if (declared && names.some(function (x) { return sameName(x, declared); })) return true;
                if (declared) return false;              // declared but different league
                const label = String((entry && (entry._activity || entry.field)) || '');
                return names.some(function (x) { return label.indexOf('League: ' + x) === 0; });
            };
            const map = function (n) { return sameName(n, oldName) ? newName : n; };

            const all = window.loadAllDailyData() || {};
            const changedDates = [];

            Object.keys(all).forEach(function (date) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
                const day = all[date];
                if (!day || typeof day !== 'object') return;
                const dayChanged = rewriteLeagueAssignments(day.leagueAssignments, ownsLeague, map)
                    + rewriteScheduleAssignments(day.scheduleAssignments, ownsLeague, map);
                if (dayChanged > 0) {
                    changedDates.push(date);
                    res.entries += dayChanged;
                }
            });

            // The live in-memory tables the grid renders from are separate
            // objects from the stored blob (hydrated per date from cloud), so
            // rewrite them IN PLACE rather than swapping in the blob's copies —
            // reassigning could clobber in-memory state that is fresher than
            // what is on disk.
            try {
                res.live = rewriteLeagueAssignments(window.leagueAssignments, ownsLeague, map)
                    + rewriteScheduleAssignments(window.scheduleAssignments, ownsLeague, map);
            } catch (_) {}

            if (!changedDates.length) { res.ok = true; return res; }

            // Persist: the localStorage blob first (what loadAllDailyData reads
            // back), then each changed date through the verified per-date path.
            try {
                localStorage.setItem('campDailyData_v1', JSON.stringify(all));
                window.invalidateDailyDataCache?.();
            } catch (e) {
                // A quota failure here leaves the local blob holding the old name
                // while the cloud gets the new one. Say so loudly — the alias map
                // still resolves the mismatch, but the user should know.
                console.warn('[TeamRename] ⚠️ local daily-data write failed (quota?) — the cloud copies below are '
                    + 'still updated, and the rename alias keeps old-name records attached to the team:', e);
            }
            changedDates.forEach(function (date) {
                try {
                    // allowCrossDate: each date is written under its OWN key, which
                    // is exactly the exemption ScheduleDB's cross-date guard is for
                    // — without it every date except the one on screen is refused.
                    window.ScheduleDB?.saveSchedule?.(date, all[date], { skipFilter: true, allowCrossDate: true });
                } catch (e) {
                    console.warn('[TeamRename] cloud save failed for ' + date + ':', e);
                }
            });

            // Re-render the grid if the day on screen shows the renamed team, so
            // the user sees the new name without switching dates.
            if (res.live > 0) {
                try { window.UnifiedScheduleSystem?.renderStaggeredView?.(); } catch (_) {}
            }

            res.dates = changedDates;
            res.ok = true;
            return res;
        } catch (e) {
            res.reason = String((e && e.message) || e);
            console.error('[TeamRename] daily-schedule migration failed:', e);
            return res;
        }
    }
    LTR.applyToDailySchedules = applyToDailySchedules;

    // =========================================================================
    // VALIDATION
    // =========================================================================
    /**
     * Decide whether `oldName` → `newName` is allowed for this league.
     * Returns { ok, reason, newName } with `newName` trimmed.
     */
    function validateRename(league, oldName, newName) {
        const trimmed = String(newName == null ? '' : newName).trim();
        if (!league) return { ok: false, reason: 'No league.' };
        if (!isRealTeamName(oldName)) return { ok: false, reason: 'No team selected.' };
        if (!trimmed) return { ok: false, reason: 'Team name cannot be empty.' };
        if (!isRealTeamName(trimmed)) {
            return { ok: false, reason: '"' + trimmed + '" is reserved by the scheduler — pick another name.' };
        }
        const teams = league.teams || [];
        if (!teams.some(function (t) { return sameName(t, oldName); })) {
            return { ok: false, reason: '"' + oldName + '" is not a team in this league.' };
        }
        if (trimmed === oldName) return { ok: false, reason: 'unchanged', unchanged: true, newName: trimmed };
        // A pure case/spacing fix keeps the same identity, so it is allowed even
        // though the normalized names collide.
        const collides = teams.some(function (t) {
            return !sameName(t, oldName) && sameName(t, trimmed);
        });
        if (collides) {
            return { ok: false, reason: 'This league already has a team called "' + trimmed + '".' };
        }
        return { ok: true, newName: trimmed };
    }
    LTR.validateRename = validateRename;

    if (typeof window !== 'undefined') window.LeagueTeamRename = LTR;
    if (typeof module !== 'undefined' && module.exports) module.exports = LTR;
})();
