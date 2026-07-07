/* =============================================================================
 * POST-EDIT FIELD CHANGE  (window.PostEditFieldChange)
 * -----------------------------------------------------------------------------
 * Lets a user reassign the FIELD/COURT of a placed game AFTER generation, for
 * the three block types that the normal activity-edit modal can't reach:
 *
 *   • Regular league game   — field lives inside the matchup string
 *                             "Team A vs Team B @ Field (Sport)" in
 *                             leagueAssignments[div][slot] + every participant
 *                             bunk's _allMatchups.
 *   • Specialty league game — "Team A vs Team B — Field" strings PLUS structured
 *                             objects (uiEntry.matchups[], entry._assignments[])
 *                             PLUS specialtyLeagueHistory.gameLog[id][date][i].field.
 *   • Elective / special    — field is the per-bunk entry's _location / field.
 *
 * UX (per product decision): two-step — pick ONE game, then edit its teams /
 * sport / field. Teams + sport edits can be saved WITHOUT moving fields (the
 * "Save changes — keep field" button is always available).
 * Field conflicts are blocked BY DEFAULT (only free fields are clickable), but
 * an OVERRIDE toggle lets the user deliberately pick any field — even one
 * already in use — after a double-book warning.
 *
 * Pure helpers (parseMatchup / rebuildMatchup / normalizeGame) are exported on
 * the namespace so tests/post_edit_field_change.test.js can exercise the fragile
 * string parse/rebuild without a DOM.
 * ========================================================================== */
(function () {
  'use strict';

  var PEFC = {};

  // ── small utils ──────────────────────────────────────────────────────────
  function norm(s) { return String(s == null ? '' : s).toLowerCase().trim(); }
  function esc(s) {
    if (window.CampUtils && typeof window.CampUtils.escapeHtml === 'function') return window.CampUtils.escapeHtml(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── PURE: matchup string parse / rebuild ─────────────────────────────────
  // Returns { kind, teamA, teamB, teams, field, sport, raw }
  //   kind: 'at'   → "A vs B @ Field (Sport)"   (regular league)
  //         'dash' → "A vs B — Field"           (specialty league)
  //         'bye' | 'chinuch' | 'unknown'       (not field-editable)
  PEFC.parseMatchup = function (raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return { kind: 'unknown', raw: text };
    if (/[—-]\s*bye\s*$/i.test(text)) return { kind: 'bye', raw: text };
    if (/[—-]\s*chinuch/i.test(text)) return { kind: 'chinuch', raw: text };

    // "A vs B @ Field (Sport)"
    var m = text.match(/^(.+?)\s+vs\.?\s+(.+?)\s*@\s*(.+?)\s*\((.+?)\)\s*$/i);
    if (m) {
      return {
        kind: 'at', teamA: m[1].trim(), teamB: m[2].trim(),
        teams: m[1].trim() + ' vs ' + m[2].trim(),
        field: m[3].trim(), sport: m[4].trim(), raw: text
      };
    }
    // "A vs B — Field"  (em-dash OR hyphen; field runs to end of string)
    var d = text.match(/^(.+?)\s+vs\.?\s+(.+?)\s*[—-]\s*(.+)$/i);
    if (d) {
      return {
        kind: 'dash', teamA: d[1].trim(), teamB: d[2].trim(),
        teams: d[1].trim() + ' vs ' + d[2].trim(),
        field: d[3].trim(), sport: '', raw: text
      };
    }
    return { kind: 'unknown', raw: text };
  };

  // Rebuild a matchup STRING in the same format it was parsed from, swapping field.
  PEFC.rebuildMatchup = function (parsed, newField) {
    if (!parsed) return '';
    if (parsed.kind === 'at') return parsed.teams + ' @ ' + newField + ' (' + parsed.sport + ')';
    if (parsed.kind === 'dash') return parsed.teams + ' — ' + newField;
    return parsed.raw;
  };

  PEFC.isEditableMatchup = function (p) { return !!p && (p.kind === 'at' || p.kind === 'dash'); };

  // Normalize a raw matchup (string OR structured {teamA,teamB,field}) → game obj.
  PEFC.normalizeGame = function (item, sportFallback, isSpecialty) {
    if (item && typeof item === 'object' && (item.teamA || item.team1)) {
      var tA = item.teamA || item.team1, tB = item.teamB || item.team2;
      return {
        kind: isSpecialty ? 'dash' : 'at',
        teamA: tA, teamB: tB, teams: tA + ' vs ' + tB,
        field: item.field || '', sport: item.sport || sportFallback || '', raw: null
      };
    }
    return PEFC.parseMatchup(item);
  };

  // Two games are "the same matchup" if their unordered team pair matches.
  function sameTeams(a, b) {
    var a1 = norm(a.teamA), a2 = norm(a.teamB), b1 = norm(b.teamA), b2 = norm(b.teamB);
    return (a1 === b1 && a2 === b2) || (a1 === b2 && a2 === b1);
  }

  // ── slot / time helpers ──────────────────────────────────────────────────
  function slotIndicesForRange(divName, startMin, endMin, fallbackIdx) {
    var dt = window.divisionTimes && window.divisionTimes[divName];
    var out = [];
    if (Array.isArray(dt) && startMin != null && endMin != null) {
      for (var i = 0; i < dt.length; i++) {
        var s = dt[i]; if (!s) continue;
        if (s.startMin == null || s.endMin == null) continue;
        if (s.startMin < endMin && s.endMin > startMin) out.push(i);
      }
    }
    if (!out.length && fallbackIdx != null) out.push(fallbackIdx);
    return out;
  }

  // ── field availability (HARD BLOCK) ──────────────────────────────────────
  // TIME-OVERLAP conflict: a field is taken if anything else overlaps the game's
  // window AT ALL — even by a few minutes into the start or end. Standard overlap
  // test (otherStart < endMin && otherEnd > startMin) catches any partial overlap.
  function fieldHasTimeConflict(fieldName, ctx) {
    if (!fieldName || ctx.startMin == null || ctx.endMin == null) return false;
    var nf = norm(fieldName);
    var ownField = ctx.game ? norm(ctx.game.field) : '';
    // The game's own current field is never a conflict for itself.
    if (nf === ownField) return false;

    // (a) GlobalFieldLocks (other league/elective claims) — time-based.
    var GFL = window.GlobalFieldLocks;
    if (GFL && typeof GFL.isFieldLockedByTime === 'function') {
      try {
        if (GFL.isFieldLockedByTime(fieldName, ctx.startMin, ctx.endMin, ctx.divName)) return true;
      } catch (e) { /* fall through */ }
    }

    // (b) Any scheduled entry whose TIME window overlaps ours and that uses this
    //     field. CRITICAL: a league entry's `field` is "League: X" — the real
    //     field lives in the matchup STRING / _assignments. So a senior-division
    //     league on this field (different grade!) is only visible by parsing those.
    var sa = window.scheduleAssignments || {};
    for (var bunk in sa) {
      if (!Object.prototype.hasOwnProperty.call(sa, bunk)) continue;
      var row = sa[bunk]; if (!Array.isArray(row)) continue;
      for (var i = 0; i < row.length; i++) {
        var e = row[i]; if (!e) continue;
        var s = (e._startMin != null) ? e._startMin : null;
        var en = (e._endMin != null) ? e._endMin : null;
        if (s == null || en == null) continue;
        if (!(s < ctx.endMin && en > ctx.startMin)) continue; // no time overlap
        // Every field this entry occupies at that time: its own field + any
        // field named inside its league matchups.
        var label = (typeof window.fieldLabel === 'function') ? window.fieldLabel(e.field) : e.field;
        if (label && norm(label) === nf) return true;
        if (Array.isArray(e._allMatchups)) {
          for (var k = 0; k < e._allMatchups.length; k++) {
            var p = PEFC.parseMatchup(e._allMatchups[k]);
            if (p.field && norm(p.field) === nf) return true;
          }
        }
        if (Array.isArray(e._assignments)) {
          for (var j = 0; j < e._assignments.length; j++) {
            var a = e._assignments[j];
            if (a && a.field && norm(a.field) === nf) return true;
          }
        }
      }
    }
    return false;
  }

  // Three-stage candidate filter (per the spec):
  //   1. fields that can HOST the sport,
  //   2. that are AVAILABLE TO THE GRADE (access restrictions),
  //   3. that are FREE at the time — nobody else on it, even a few minutes of
  //      overlap, and no over-capacity.
  // Reuses the generator's own findFieldsForActivity for (1)+(2)+capacity so the
  // picker matches what the solver would allow; (3)'s time-overlap is enforced
  // explicitly here so partial overlaps can never slip through.
  function candidateFields(ctx) {
    var sport = ctx.selectedSport || (ctx.game && ctx.game.sport) || '';
    var ownField = ctx.game ? norm(ctx.game.field) : '';
    var seen = {}, rows = [];
    function add(name, capacity, freeFlag) {
      var k = norm(name); if (seen[k]) return; seen[k] = 1;
      var isCur = k === ownField;
      rows.push({ name: name, capacity: capacity || 1, current: isCur, free: isCur ? false : !!freeFlag });
    }

    var usedFinder = false;
    if (typeof window.findFieldsForActivity === 'function' && sport) {
      var res;
      try { res = window.findFieldsForActivity(sport, ctx.slots || [], ctx.divName, null, ctx.startMin, ctx.endMin); }
      catch (e) { res = null; }
      if (res) {
        usedFinder = true;
        // RESPECT the generator's verdict. `open` = free per the solver, but a
        // SHARED (under-capacity) field is still taken for an exclusive league
        // game, and our own time-overlap gate can only make it stricter.
        (res.open || []).forEach(function (f) {
          add(f.name, f.capacity, !f.shared && !fieldHasTimeConflict(f.name, ctx));
        });
        // `busy` = blocked by the solver (league_locked / capacity / time rules /
        // combo). Keep them listed as unavailable; DROP access_restricted (stage 2
        // — not available to this grade) so they're not even shown.
        (res.busy || []).forEach(function (f) {
          if (f.reason === 'access_restricted') return;
          add(f.name, f.capacity, false);
        });
      }
    }
    // Fallback when the generator finder isn't loaded: getAllLocations by sport.
    if (!usedFinder) {
      var locs = (typeof window.getAllLocations === 'function') ? (window.getAllLocations() || []) : [];
      locs.filter(function (l) {
        return l && l.type === 'field' && (!sport || (l.activities || []).some(function (a) { return norm(a) === norm(sport); }));
      }).forEach(function (l) { add(l.name, l.capacity, !fieldHasTimeConflict(l.name, ctx)); });
    }
    return rows.sort(function (a, b) { return (b.free - a.free) || a.name.localeCompare(b.name); });
  }

  // Used by applyFieldChange's final guard.
  function fieldIsFree(fieldName, ctx) {
    if (!fieldName) return false;
    if (ctx.game && norm(fieldName) === norm(ctx.game.field)) return true;
    return !fieldHasTimeConflict(fieldName, ctx);
  }

  // Sports that have at least one hosting field (for the sport dropdown).
  function allSports() {
    var locs = (typeof window.getAllLocations === 'function') ? (window.getAllLocations() || []) : [];
    var set = {};
    locs.filter(function (l) { return l && l.type === 'field'; })
      .forEach(function (l) { (l.activities || []).forEach(function (a) { if (a) set[a] = true; }); });
    return Object.keys(set).sort();
  }

  // Teams / sports configured for a league (drives the matchup-editor dropdowns).
  function leagueConfig(leagueName) {
    var byName = window.leaguesByName ||
      (typeof window.loadGlobalSettings === 'function' && (window.loadGlobalSettings() || {}).leaguesByName) || {};
    var lg = byName && byName[leagueName];
    if (!lg) {
      var k = Object.keys(byName || {}).filter(function (n) { return norm(n) === norm(leagueName); })[0];
      lg = k ? byName[k] : null;
    }
    return { teams: (lg && Array.isArray(lg.teams)) ? lg.teams.slice() : [] };
  }

  // ── context builder ──────────────────────────────────────────────────────
  // Returns null if the slot holds no editable league/specialty games.
  function buildSlotContext(divName, slotIdx, entryHint) {
    var la = (window.leagueAssignments && window.leagueAssignments[divName]) || {};
    var laEntry = la[slotIdx] || la[String(slotIdx)] || null;

    var isSpecialty = !!((entryHint && entryHint._isSpecialtyLeague) ||
      (laEntry && (laEntry.isSpecialtyLeague || laEntry._isSpecialtyLeague)));
    var leagueName = (entryHint && entryHint._leagueName) ||
      (laEntry && (laEntry.leagueName || laEntry._leagueName)) || '';
    var sportFallback = (entryHint && entryHint.sport) || (laEntry && laEntry.sport) || '';

    var dt = window.divisionTimes && window.divisionTimes[divName];
    var slot = Array.isArray(dt) ? dt[slotIdx] : null;
    // Prefer an explicit time hint (auto mode's division-level divisionTimes can
    // mismatch the per-bunk league time), then the slot grid, then laEntry.
    var startMin = (entryHint && entryHint._startMin != null) ? entryHint._startMin
      : (slot && slot.startMin != null) ? slot.startMin
        : (laEntry && laEntry._startMin != null) ? laEntry._startMin : null;
    var endMin = (entryHint && entryHint._endMin != null) ? entryHint._endMin
      : (slot && slot.endMin != null) ? slot.endMin
        : (laEntry && laEntry._endMin != null) ? laEntry._endMin : null;

    var rawList = (entryHint && entryHint._allMatchups) ||
      (laEntry && (laEntry.matchups || laEntry._allMatchups)) || [];
    var games = (rawList || [])
      .map(function (it) { return PEFC.normalizeGame(it, sportFallback, isSpecialty); })
      .filter(PEFC.isEditableMatchup);

    if (!games.length) return null;

    // Specialty fallback: when the league flag wasn't carried on the hint/entry,
    // the matchup STRING format reveals it — specialty uses "A vs B — Field"
    // (dash), regular uses "A vs B @ Field (Sport)" (at). This keeps the gameLog
    // history update firing for specialty games reached via the unified cell.
    if (!isSpecialty && games.some(function (g) { return g.kind === 'dash'; })) isSpecialty = true;

    return {
      kind: isSpecialty ? 'specialty' : 'regular',
      divName: divName, slotIdx: slotIdx,
      startMin: startMin, endMin: endMin,
      leagueName: leagueName, sportFallback: sportFallback,
      slots: slotIndicesForRange(divName, startMin, endMin, slotIdx),
      games: games,
      game: null // chosen later
    };
  }

  // ── APPLY ────────────────────────────────────────────────────────────────
  // Rewrites the field of ctx.game across every store, swaps the field lock,
  // and persists. Returns { ok, message }.
  PEFC.applyFieldChange = function (ctx, newField, newSport, newTeams, opts) {
    if (!ctx || !ctx.game || !newField) return { ok: false, message: 'Nothing to change.' };
    var override = !!(opts && opts.override); // user chose to bypass the field-busy block
    var oldField = ctx.game.field;
    var oldA = ctx.game.teamA, oldB = ctx.game.teamB, oldSport = ctx.game.sport;
    // Resolve new teams (fall back to old); unordered compare for "changed".
    var newA = (newTeams && newTeams.teamA != null && newTeams.teamA !== '') ? newTeams.teamA : oldA;
    var newB = (newTeams && newTeams.teamB != null && newTeams.teamB !== '') ? newTeams.teamB : oldB;
    var changeTeams = !((norm(newA) === norm(oldA) && norm(newB) === norm(oldB)) ||
                        (norm(newA) === norm(oldB) && norm(newB) === norm(oldA)));
    // A sport / teams change alone (same field) is allowed; otherwise require free.
    var changeSport = !!(newSport && norm(newSport) !== norm(ctx.game.sport || ''));
    if (norm(oldField) === norm(newField) && !changeSport && !changeTeams) return { ok: false, message: 'Nothing changed.' };
    if (changeTeams && norm(newA) === norm(newB)) return { ok: false, message: 'A team cannot play itself.' };
    // Field-busy is a hard block UNLESS the user explicitly overrode it (warned).
    if (norm(oldField) !== norm(newField) && !override && !fieldIsFree(newField, ctx)) return { ok: false, message: newField + ' is already in use at this time.' };

    var newTeamsStr = newA + ' vs ' + newB;
    // Rebuild a matchup string with the new field AND (regular-league "@"
    // matchups carry the sport) the new sport AND the new teams.
    function rebuilt(p) {
      if (changeSport) p.sport = newSport;
      if (changeTeams) p.teams = newTeamsStr;
      return PEFC.rebuildMatchup(p, newField);
    }
    function setTeamsOn(o) {
      if (!changeTeams) return;
      if ('team1' in o) o.team1 = newA; if ('teamA' in o || !('team1' in o)) o.teamA = newA;
      if ('team2' in o) o.team2 = newB; if ('teamB' in o || !('team2' in o)) o.teamB = newB;
    }

    var touchedBunks = [];

    // Match ONLY the specific game: same unordered team pair AND currently on the
    // old field (so a double-header — same teams twice in a day on two fields —
    // doesn't get both legs clobbered).
    function isTarget(p) {
      return PEFC.isEditableMatchup(p) && sameTeams(p, ctx.game) && norm(p.field) === norm(oldField);
    }
    function isTargetObj(o) {
      var t = { teamA: o.teamA || o.team1, teamB: o.teamB || o.team2 };
      return sameTeams(t, ctx.game) && norm(o.field) === norm(oldField);
    }

    // (1) Per-bunk scheduleAssignments. In AUTO mode the same game can sit at a
    //     DIFFERENT slot index per bunk, so scan the whole row — not ctx.slotIdx.
    var sa = window.scheduleAssignments || {};
    for (var bunk in sa) {
      if (!Object.prototype.hasOwnProperty.call(sa, bunk)) continue;
      var row = sa[bunk]; if (!Array.isArray(row)) continue;
      var changed = false;
      for (var si = 0; si < row.length; si++) {
        var entry = row[si];
        if (!entry) continue;
        if (Array.isArray(entry._allMatchups)) {
          for (var k = 0; k < entry._allMatchups.length; k++) {
            var p = PEFC.parseMatchup(entry._allMatchups[k]);
            if (isTarget(p)) { entry._allMatchups[k] = rebuilt(p); changed = true; }
          }
        }
        if (Array.isArray(entry._assignments)) {
          entry._assignments.forEach(function (a) {
            if (a && isTargetObj(a)) { a.field = newField; if (changeSport) a.sport = newSport; setTeamsOn(a); changed = true; }
          });
        }
      }
      if (changed) touchedBunks.push(bunk);
    }

    // (2) leagueAssignments — scan EVERY division, not just ctx.divName. When two
    //     grades are CONNECTED in a league they each hold a copy of the same game
    //     (matched by team-pair + old field), so a field/sport change made from
    //     one grade auto-updates the other.
    var laAll = window.leagueAssignments || {};
    Object.keys(laAll).forEach(function (dn) {
      var la = laAll[dn]; if (!la) return;
      Object.keys(la).forEach(function (slotKey) {
        var laEntry = la[slotKey];
        if (!laEntry) return;
        ['_allMatchups', 'matchups'].forEach(function (key) {
          if (!Array.isArray(laEntry[key])) return;
          for (var k = 0; k < laEntry[key].length; k++) {
            var item = laEntry[key][k];
            if (typeof item === 'string') {
              var p = PEFC.parseMatchup(item);
              if (isTarget(p)) laEntry[key][k] = rebuilt(p);
            } else if (item && typeof item === 'object' && (item.teamA || item.team1)) {
              if (isTargetObj(item)) { item.field = newField; if (changeSport) item.sport = newSport; setTeamsOn(item); }
            }
          }
        });
      });
    });

    // (3) Rotation history sync.
    if (ctx.kind === 'specialty') {
      // Specialty bracket/print gameLog — best-effort.
      try { updateSpecialtyGameLog(ctx, newField, changeSport ? newSport : null, changeTeams ? { teamA: newA, teamB: newB } : null); }
      catch (e) { console.warn('[PEFC] specialty gameLog update skipped:', e); }
    } else if (changeTeams || changeSport) {
      // Regular-league variety stores (gameLog/matchupHistory/teamSports) — only
      // when teams/sport actually changed (a pure field move doesn't affect them).
      try {
        if (window.SchedulerCoreLeagues && typeof window.SchedulerCoreLeagues.editGameRecord === 'function') {
          // ★ Use the date of the schedule actually loaded/edited (the unified
          //   loader stamps window._scheduleAssignmentsDate when it loads a date
          //   into window.scheduleAssignments — the very data applyFieldChange
          //   mutates). window.currentScheduleDate is the global PICKER, which can
          //   point at a different day than the grid being edited (e.g. viewing a
          //   past date while the picker sits on another) — that mismatch sent the
          //   rotation-history edit to the wrong day, so the change was never
          //   reflected in the gameLog. Fall back to the picker if the stamp is unset.
          window.SchedulerCoreLeagues.editGameRecord(
            ctx.leagueName, (window._scheduleAssignmentsDate || window.currentScheduleDate),
            { teamA: oldA, teamB: oldB, sport: oldSport },
            { teamA: newA, teamB: newB, sport: changeSport ? newSport : oldSport }
          );
        }
      } catch (e) { console.warn('[PEFC] league rotation sync skipped:', e); }
    }

    // (4) Field-lock swap so a later edit/regen can't double-book.
    var GFL = window.GlobalFieldLocks;
    if (GFL) {
      try {
        if (typeof GFL.unlockField === 'function') GFL.unlockField(oldField, ctx.slots);
        if (typeof GFL.lockField === 'function') {
          GFL.lockField(newField, ctx.slots, {
            lockedBy: ctx.kind === 'specialty' ? 'specialty_league' : 'regular_league',
            leagueName: ctx.leagueName, division: ctx.divName,
            activity: (changeSport ? newSport : ctx.game.sport) || ctx.leagueName
          });
        }
      } catch (e) { console.warn('[PEFC] lock swap skipped:', e); }
    }

    // (5) Persist + re-render.
    ctx.game.field = newField; // reflect for any follow-up move in the same session
    if (changeSport) ctx.game.sport = newSport;
    if (changeTeams) { ctx.game.teamA = newA; ctx.game.teamB = newB; ctx.game.teams = newTeamsStr; }
    try {
      if (typeof window.saveCurrentDailyData === 'function') {
        window.saveCurrentDailyData('scheduleAssignments', window.scheduleAssignments);
        window.saveCurrentDailyData('leagueAssignments', window.leagueAssignments || {});
      }
      if (typeof window.bypassSaveAllBunks === 'function' && touchedBunks.length) {
        Promise.resolve(window.bypassSaveAllBunks(touchedBunks)).catch(function (e) { console.warn('[PEFC] cloud save:', e); });
      }
    } catch (e) { console.warn('[PEFC] persist:', e); }
    if (typeof window.updateTable === 'function') { try { window.updateTable(); } catch (e) {} }

    return { ok: true, message: ctx.game.teams + ' → ' + newField };
  };

  function updateSpecialtyGameLog(ctx, newField, newSport, newTeams) {
    if (typeof window.loadGlobalSettings !== 'function' || typeof window.saveGlobalSettings !== 'function') return;
    var gs = window.loadGlobalSettings() || {};
    var history = gs.specialtyLeagueHistory;
    if (!history || !history.gameLog) return;
    // Resolve league id from name via configured specialty leagues.
    var leagues = gs.specialtyLeagues || [];
    var league = leagues.filter(function (l) { return norm(l.name) === norm(ctx.leagueName); })[0];
    var id = league ? league.id : null;
    // ★ Date of the schedule actually being edited (see note in applyFieldChange) —
    //   not the global picker, which can point at a different day than the grid.
    var date = window._scheduleAssignmentsDate || window.currentScheduleDate;
    if (!id || !date || !history.gameLog[id] || !history.gameLog[id][date]) return;
    var entries = history.gameLog[id][date];
    var hit = false;
    entries.forEach(function (g) {
      // ctx.game still holds the OLD teams/field here (reset later).
      if (sameTeams({ teamA: g.tA, teamB: g.tB }, ctx.game) && norm(g.field) === norm(ctx.game.field)) {
        g.field = newField;
        if (newSport != null && newSport !== '') g.sport = newSport;
        if (newTeams && newTeams.teamA != null && newTeams.teamA !== '') g.tA = newTeams.teamA;
        if (newTeams && newTeams.teamB != null && newTeams.teamB !== '') g.tB = newTeams.teamB;
        hit = true;
      }
    });
    if (hit) window.saveGlobalSettings('specialtyLeagueHistory', history);
  }

  // ── MODAL UI ─────────────────────────────────────────────────────────────
  var OVERLAY_ID = 'pefc-overlay';
  function closeModal() { var el = document.getElementById(OVERLAY_ID); if (el) el.remove(); }

  function shell(innerHtml) {
    closeModal();
    var ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    var _mdFieldChangeOv = false;
    ov.addEventListener('mousedown', function (e) { _mdFieldChangeOv = (e.target === ov); });
    ov.onclick = function (e) { if (e.target === ov && _mdFieldChangeOv) closeModal(); };
    var box = document.createElement('div');
    // Roomy on desktop (field buttons + play report need the width), shrinks
    // cleanly on small screens.
    box.style.cssText = 'background:#fff;border-radius:12px;padding:24px 26px;width:min(620px,94vw);box-sizing:border-box;box-shadow:0 20px 60px rgba(0,0,0,0.3);max-height:88vh;overflow:auto;';
    box.onclick = function (e) { e.stopPropagation(); };
    box.innerHTML = innerHtml;
    ov.appendChild(box);
    document.body.appendChild(ov);
    return box;
  }

  function header(title) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
      '<h2 style="margin:0;font-size:1.15rem;color:#1f2937;">' + esc(title) + '</h2>' +
      '<button id="pefc-close" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#9ca3af;">&times;</button></div>';
  }

  // League play-history mini report (who played what & when) shown inside the
  // edit modal — compact: matchup + sport notes for the game being edited,
  // full history behind a collapsed toggle. Rendered by league_play_report.js.
  function miniReportHtml(ctx, highlightTeams, selectedSport) {
    if (!ctx || !ctx.leagueName) return '';
    var LPR = window.LeaguePlayReport;
    if (!LPR || typeof LPR.renderMiniCard !== 'function') return '';
    try {
      return LPR.renderMiniCard(ctx.leagueName, ctx.kind === 'specialty' ? 'specialty' : 'regular',
        { highlightTeams: highlightTeams || [], selectedSport: selectedSport || '' });
    } catch (e) { return ''; }
  }

  function showGamePicker(ctx) {
    // Tiny per-game history note ("First meeting" / "Played 2× · last Jul 6")
    // instead of a full report — the picker stays a simple list.
    var lprData = null;
    var LPR = window.LeaguePlayReport;
    if (ctx.leagueName && LPR && typeof LPR.buildData === 'function') {
      try { lprData = LPR.buildData(ctx.leagueName, ctx.kind === 'specialty' ? 'specialty' : 'regular'); }
      catch (e) { lprData = null; }
    }
    var rows = ctx.games.map(function (g, i) {
      var histNote = '';
      if (lprData && typeof LPR.pairNoteHtml === 'function') {
        var n = LPR.pairNoteHtml(null, ctx.kind, g.teamA, g.teamB, lprData);
        if (n) histNote = '<div style="font-size:0.72rem;margin-top:2px;">' + n + '</div>';
      }
      return '<button class="pefc-game" data-i="' + i + '" style="display:block;width:100%;text-align:left;padding:11px 13px;margin-bottom:8px;border:1.5px solid #e5e7eb;border-radius:9px;background:#f9fafb;cursor:pointer;font-size:0.92rem;">' +
        '<div style="font-weight:600;color:#1f2937;">' + esc(g.teams) + '</div>' +
        '<div style="font-size:0.8rem;color:#6b7280;margin-top:2px;">' +
        (g.sport ? esc(g.sport) + ' · ' : '') + 'Currently: <strong>' + esc(g.field || '—') + '</strong></div>' +
        histNote + '</button>';
    }).join('');
    var box = shell(header('Edit a league game') +
      '<div style="font-size:0.85rem;color:#6b7280;margin-bottom:12px;">' + esc(ctx.leagueName || 'League') + ' — pick the game to edit:</div>' +
      rows);
    box.querySelector('#pefc-close').onclick = closeModal;
    box.querySelectorAll('.pefc-game').forEach(function (btn) {
      btn.onclick = function () {
        ctx.game = ctx.games[parseInt(btn.dataset.i, 10)];
        showFieldPicker(ctx);
      };
    });
  }

  function showFieldPicker(ctx) {
    var cands = candidateFields(ctx);
    var freeOnes = cands.filter(function (c) { return c.free; });
    var busyOnes = cands.filter(function (c) { return !c.free; });

    // Sport editor — only for regular-league matchups, whose string carries the
    // sport ("A vs B @ Field (Sport)"). Specialty ("A vs B — Field") has none.
    var canEditSport = ctx.game.kind === 'at';
    var curSport = ctx.selectedSport || ctx.game.sport || '';
    var sportHtml = '';
    if (canEditSport) {
      var opts = allSports();
      if (curSport && opts.indexOf(curSport) === -1) opts = [curSport].concat(opts);
      sportHtml = '<div style="margin-bottom:14px;">' +
        '<label style="display:block;font-weight:600;font-size:0.82rem;color:#374151;margin-bottom:6px;">Sport</label>' +
        '<select id="pefc-sport" style="width:100%;padding:9px 11px;border:1.5px solid #6366f1;border-radius:8px;font-size:0.9rem;background:#fff;cursor:pointer;">' +
        opts.map(function (s) { return '<option value="' + esc(s) + '"' + (norm(s) === norm(curSport) ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') +
        '</select></div>';
    }

    // Teams editor — change who plays whom (regular + specialty). Selections
    // persist across sport re-renders via ctx.selectedTeamA/B.
    if (ctx.selectedTeamA == null) ctx.selectedTeamA = ctx.game.teamA;
    if (ctx.selectedTeamB == null) ctx.selectedTeamB = ctx.game.teamB;
    var cfgTeams = leagueConfig(ctx.leagueName).teams;
    var curA = ctx.selectedTeamA, curB = ctx.selectedTeamB;
    function teamCtl(id, sel) {
      var st = 'flex:1;min-width:0;padding:8px 10px;border:1.5px solid #6366f1;border-radius:8px;font-size:0.88rem;background:#fff;';
      if (cfgTeams.length >= 2) {
        var opts = cfgTeams.slice();
        if (sel && opts.map(norm).indexOf(norm(sel)) === -1) opts = [sel].concat(opts);
        return '<select id="' + id + '" style="' + st + 'cursor:pointer;">' +
          opts.map(function (t) { return '<option value="' + esc(t) + '"' + (norm(t) === norm(sel) ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select>';
      }
      return '<input id="' + id + '" type="text" value="' + esc(sel || '') + '" style="' + st + '">';
    }
    var teamsHtml = '<div style="margin-bottom:14px;">' +
      '<label style="display:block;font-weight:600;font-size:0.82rem;color:#374151;margin-bottom:6px;">Teams</label>' +
      '<div style="display:flex;gap:8px;align-items:center;">' + teamCtl('pefc-teamA', curA) +
      '<span style="color:#9ca3af;font-size:0.85rem;">vs</span>' + teamCtl('pefc-teamB', curB) + '</div></div>';
    var teamsChanged = !((norm(curA) === norm(ctx.game.teamA) && norm(curB) === norm(ctx.game.teamB)) ||
                         (norm(curA) === norm(ctx.game.teamB) && norm(curB) === norm(ctx.game.teamA)));

    // OVERRIDE: when on, ANY field — even one already in use — becomes a
    // clickable button so the user can deliberately place the game where they
    // want (a double-book confirm fires on click). Off → only free fields are
    // clickable and busy ones show as plain greyed text (conflict-safe default).
    var override = !!ctx.override;

    // Render one field as a button. `busy` fields are only clickable under
    // override; the current field is never re-rendered as a button (it's shown
    // in the summary header above).
    function fieldBtn(c, busy) {
      var isCur = norm(c.name) === norm(ctx.game.field);
      var clickable = !isCur && (!busy || override);
      var border = isCur ? '#cbd5e1' : (busy ? (override ? '#fca5a5' : '#e5e7eb') : '#86efac');
      var bg = isCur ? '#f1f5f9' : (busy ? (override ? '#fef2f2' : '#f9fafb') : '#f0fdf4');
      var color = isCur ? '#94a3b8' : (busy ? (override ? '#b91c1c' : '#9ca3af') : '#065f46');
      return '<button class="pefc-field" data-f="' + esc(c.name) + '" data-busy="' + (busy ? '1' : '') + '" ' + (clickable ? '' : 'disabled') +
        ' style="padding:8px 13px;margin:0 8px 8px 0;border:1.5px solid ' + border + ';border-radius:8px;background:' + bg + ';color:' + color + ';font-size:0.85rem;font-weight:500;cursor:' + (clickable ? 'pointer' : 'default') + ';">' +
        (busy && override ? '⚠ ' : '') + esc(c.name) + (isCur ? ' (current)' : '') +
        (c.capacity > 1 ? ' <span style="opacity:0.6;font-size:0.75rem;">(cap:' + c.capacity + ')</span>' : '') +
        (busy && override ? ' <span style="opacity:0.75;font-size:0.72rem;">in use</span>' : '') + '</button>';
    }

    // Don't list the game's own current field (it's just where the game already
    // is). Everything else busy is genuinely occupied/blocked.
    var busyReal = busyOnes.filter(function (c) { return !c.current; });
    var freeHtml = freeOnes.map(function (c) { return fieldBtn(c, false); }).join('');

    var noFreeNote = (!freeOnes.length && !override)
      ? '<div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px;font-size:0.85rem;color:#78350f;">No free fields for this game at this time. Turn on Override below to place it anyway, or free up a field first.</div>'
      : '';

    var overrideHtml =
      '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;margin-bottom:4px;font-size:0.82rem;color:#7c2d12;cursor:pointer;user-select:none;">' +
      '<input type="checkbox" id="pefc-override"' + (override ? ' checked' : '') + ' style="width:16px;height:16px;cursor:pointer;">' +
      'Override — let me pick <strong>any</strong> field (may double-book)</label>';

    // Busy fields: clickable warning buttons under override, plain text otherwise.
    var busyHtml = override
      ? (busyReal.length ? '<div style="margin-top:6px;"><div style="font-weight:600;font-size:0.8rem;color:#b91c1c;margin-bottom:6px;">In use — pick to place anyway:</div><div style="display:flex;flex-wrap:wrap;">' + busyReal.map(function (c) { return fieldBtn(c, true); }).join('') + '</div></div>' : '')
      : (busyReal.length ? '<div style="margin-top:12px;font-size:0.78rem;color:#9ca3af;">In use: ' + busyReal.map(function (c) { return esc(c.name); }).join(', ') + '</div>' : '');

    // "Save changes" is ALWAYS available so a teams / sport edit can be committed
    // WITHOUT moving fields (field buttons MOVE the game; this keeps it put).
    // Highlighted when an edit is actually pending.
    var sportChanged = canEditSport && norm(curSport) !== norm(ctx.game.sport || '');
    var pendingChange = sportChanged || teamsChanged;
    var keepFieldHtml =
      '<button id="pefc-keep-field" style="width:100%;margin-top:14px;padding:9px;border:1.5px solid ' + (pendingChange ? '#6366f1' : '#d1d5db') + ';border-radius:8px;background:' + (pendingChange ? '#eef2ff' : '#fff') + ';color:' + (pendingChange ? '#4338ca' : '#6b7280') + ';font-size:0.85rem;font-weight:600;cursor:pointer;">Save changes — keep ' + esc(ctx.game.field || 'current field') + '</button>';

    var box = shell(header('Edit league game') +
      '<div style="background:#f3f4f6;padding:9px 12px;border-radius:8px;margin-bottom:14px;font-size:0.85rem;">' +
      '<div style="font-weight:600;color:#374151;">' + esc(ctx.game.teams) + '</div>' +
      '<div style="color:#6b7280;margin-top:2px;">' + (ctx.game.sport ? esc(ctx.game.sport) + ' · ' : '') + 'now on <strong>' + esc(ctx.game.field || '—') + '</strong></div></div>' +
      miniReportHtml(ctx, [curA, curB], canEditSport ? curSport : (ctx.game.sport || '')) +
      teamsHtml +
      sportHtml +
      '<div style="font-weight:600;font-size:0.82rem;color:#166534;margin-bottom:8px;">Available fields' + (canEditSport ? ' for ' + esc(curSport) : '') + ':</div>' +
      '<div style="display:flex;flex-wrap:wrap;">' + freeHtml + '</div>' + noFreeNote + overrideHtml + busyHtml + keepFieldHtml +
      '<div style="display:flex;gap:10px;margin-top:18px;">' +
      (ctx.games.length > 1 ? '<button id="pefc-back" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;cursor:pointer;font-weight:500;">← Back</button>' : '') +
      '<button id="pefc-cancel" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;cursor:pointer;font-weight:500;">Cancel</button></div>');

    box.querySelector('#pefc-close').onclick = closeModal;
    box.querySelector('#pefc-cancel').onclick = closeModal;
    var back = box.querySelector('#pefc-back');
    if (back) back.onclick = function () { showGamePicker(ctx); };

    // Read the (possibly edited) teams from the controls.
    function readTeams() {
      var a = box.querySelector('#pefc-teamA'), b = box.querySelector('#pefc-teamB');
      return { teamA: a ? String(a.value || '').trim() : curA, teamB: b ? String(b.value || '').trim() : curB };
    }

    // Capture any pending team / sport edits before a re-render so they survive
    // it (changing sport re-filters the field list; toggling override re-renders).
    function captureEdits() {
      var t = readTeams(); ctx.selectedTeamA = t.teamA; ctx.selectedTeamB = t.teamB;
      if (sportSel) ctx.selectedSport = sportSel.value;
    }

    var sportSel = box.querySelector('#pefc-sport');
    if (sportSel) sportSel.onchange = function () {
      captureEdits(); ctx.selectedSport = sportSel.value; showFieldPicker(ctx);
    };

    // Team edits re-tint the play-history mini report so the pair being
    // considered is highlighted live (no full re-render needed).
    function refreshMiniReport() {
      var LPR = window.LeaguePlayReport;
      if (!LPR || typeof LPR.refreshMiniBody !== 'function' || !ctx.leagueName) return;
      var t = readTeams();
      var sp = sportSel ? sportSel.value : (ctx.game.sport || '');
      try {
        LPR.refreshMiniBody(ctx.leagueName, ctx.kind === 'specialty' ? 'specialty' : 'regular',
          { highlightTeams: [t.teamA, t.teamB], selectedSport: sp });
      } catch (e) { /* report is advisory — never block the edit */ }
    }
    ['#pefc-teamA', '#pefc-teamB'].forEach(function (id) {
      var el = box.querySelector(id);
      if (!el) return;
      el.addEventListener('change', refreshMiniReport);
      el.addEventListener('input', refreshMiniReport);
    });

    // Override toggle re-renders so busy fields become clickable warning buttons.
    var ovChk = box.querySelector('#pefc-override');
    if (ovChk) ovChk.onchange = function () {
      captureEdits(); ctx.override = ovChk.checked; showFieldPicker(ctx);
    };

    var keepBtn = box.querySelector('#pefc-keep-field');
    if (keepBtn) keepBtn.onclick = function () {
      var res = PEFC.applyFieldChange(ctx, ctx.game.field, canEditSport ? curSport : null, readTeams());
      if (!res.ok) { toast(res.message, 'warning'); return; }
      closeModal();
      toast('Updated: ' + res.message, 'success');
    };

    box.querySelectorAll('.pefc-field').forEach(function (btn) {
      if (btn.disabled) return;
      btn.onclick = function () {
        var pickSport = canEditSport ? curSport : null;
        var busy = btn.dataset.busy === '1';
        if (busy) {
          var ok = (typeof window.confirm === 'function')
            ? window.confirm(btn.dataset.f + ' is already in use at this time.\n\nPlace this game there anyway? This will double-book the field.')
            : true;
          if (!ok) return;
        }
        var res = PEFC.applyFieldChange(ctx, btn.dataset.f, pickSport, readTeams(), { override: busy });
        if (!res.ok) { toast(res.message, 'warning'); return; }
        closeModal();
        toast('Updated: ' + res.message, 'success');
      };
    });
  }

  function toast(msg, kind) {
    if (typeof window.showIntegratedToast === 'function') { window.showIntegratedToast(msg, kind || 'info', 3500); return; }
    if (typeof window.showNotification === 'function') { window.showNotification(msg, kind || 'info'); return; }
    console.log('[PEFC] ' + msg);
  }

  // ── ENTRY POINTS ─────────────────────────────────────────────────────────
  // From a per-bunk cell click (manual mode, or any _h2h/_isSpecialtyLeague cell).
  PEFC.openFromEntry = function (bunk, slotIdx, entry) {
    var divName = (typeof window.getDivisionForBunk === 'function') ? window.getDivisionForBunk(bunk) : null;
    var ctx = buildSlotContext(divName, slotIdx, entry);
    if (!ctx) { toast('No editable game found in this slot.', 'warning'); return false; }
    if (ctx.games.length === 1) { ctx.game = ctx.games[0]; showFieldPicker(ctx); }
    else showGamePicker(ctx);
    return true;
  };

  // From an auto-grid league OVERLAY card click (game already chosen).
  // gameSeed = { teamA, teamB, field, sport } parsed from the clicked card.
  PEFC.openGame = function (divName, slotIdx, gameSeed, entryHint) {
    var ctx = buildSlotContext(divName, slotIdx, entryHint);
    if (!ctx) { toast('No editable game found in this slot.', 'warning'); return false; }
    if (gameSeed) {
      var match = ctx.games.filter(function (g) { return sameTeams(g, gameSeed); })[0];
      ctx.game = match || ctx.games[0];
      showFieldPicker(ctx);
    } else if (ctx.games.length === 1) { ctx.game = ctx.games[0]; showFieldPicker(ctx); }
    else showGamePicker(ctx);
    return true;
  };

  // Is this entry one the field-change modal handles? (used by the edit router)
  PEFC.isLeagueEntry = function (entry) {
    return !!(entry && (entry._h2h || entry._league || entry._isSpecialtyLeague ||
      (Array.isArray(entry._allMatchups) && entry._allMatchups.length)));
  };

  window.PostEditFieldChange = PEFC;

  // CommonJS export for the unit tests (pure helpers only).
  if (typeof module !== 'undefined' && module.exports) module.exports = PEFC;
})();
