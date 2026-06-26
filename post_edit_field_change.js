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
 * UX (per product decision): two-step — pick ONE game, then pick its new field.
 * Conflicts are HARD-BLOCKED: a field already locked/occupied at that time is
 * not offered (no override).
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

    // (a) GlobalFieldLocks (other league/elective claims) — time-based.
    var GFL = window.GlobalFieldLocks;
    if (GFL && typeof GFL.isFieldLockedByTime === 'function') {
      try {
        var lock = GFL.isFieldLockedByTime(fieldName, ctx.startMin, ctx.endMin, ctx.divName);
        // A lock on the game's CURRENT field is this game itself — ignore it.
        if (lock && nf !== ownField) return true;
      } catch (e) { /* fall through */ }
    }

    // (b) Any scheduled entry on this field whose TIME window overlaps ours.
    var sa = window.scheduleAssignments || {};
    for (var bunk in sa) {
      if (!Object.prototype.hasOwnProperty.call(sa, bunk)) continue;
      var row = sa[bunk]; if (!Array.isArray(row)) continue;
      for (var i = 0; i < row.length; i++) {
        var e = row[i]; if (!e) continue;
        var label = (typeof window.fieldLabel === 'function') ? window.fieldLabel(e.field) : e.field;
        if (norm(label) !== nf) continue;
        if (nf === ownField) continue; // participants of this game sit on the old field
        var s = (e._startMin != null) ? e._startMin : null;
        var en = (e._endMin != null) ? e._endMin : null;
        if (s == null || en == null) continue;
        if (s < ctx.endMin && en > ctx.startMin) return true; // overlap (even 1 min)
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
    var hosts = [];

    if (typeof window.findFieldsForActivity === 'function' && sport) {
      var res;
      try { res = window.findFieldsForActivity(sport, ctx.slots || [], ctx.divName, null, ctx.startMin, ctx.endMin); }
      catch (e) { res = null; }
      if (res) {
        // open + busy both "host the sport". Drop access_restricted (stage 2:
        // not available to this grade). Everything else is a host candidate;
        // stage 3 (time overlap / capacity) decides free vs busy below.
        (res.open || []).concat(res.busy || []).forEach(function (f) {
          if (f.reason === 'access_restricted') return;
          hosts.push({ name: f.name, capacity: f.capacity || 1 });
        });
      }
    }
    // Fallback when the generator finder isn't loaded: getAllLocations by sport.
    if (!hosts.length) {
      var locs = (typeof window.getAllLocations === 'function') ? (window.getAllLocations() || []) : [];
      locs.filter(function (l) {
        return l && l.type === 'field' && (!sport || (l.activities || []).some(function (a) { return norm(a) === norm(sport); }));
      }).forEach(function (l) { hosts.push({ name: l.name, capacity: l.capacity || 1 }); });
    }

    // Dedup, then apply the explicit time-overlap gate.
    var seen = {}, out = [];
    hosts.forEach(function (h) {
      var key = norm(h.name);
      if (seen[key]) return; seen[key] = 1;
      var isCur = ctx.game && key === norm(ctx.game.field);
      out.push({ name: h.name, capacity: h.capacity, current: !!isCur, free: !isCur && !fieldHasTimeConflict(h.name, ctx) });
    });
    return out.sort(function (a, b) { return (b.free - a.free) || a.name.localeCompare(b.name); });
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
  PEFC.applyFieldChange = function (ctx, newField, newSport) {
    if (!ctx || !ctx.game || !newField) return { ok: false, message: 'Nothing to change.' };
    var oldField = ctx.game.field;
    // A sport change alone (same field) is allowed; otherwise require the field free.
    var changeSport = !!(newSport && norm(newSport) !== norm(ctx.game.sport || ''));
    if (norm(oldField) === norm(newField) && !changeSport) return { ok: false, message: 'That is already the field.' };
    if (norm(oldField) !== norm(newField) && !fieldIsFree(newField, ctx)) return { ok: false, message: newField + ' is already in use at this time.' };

    // Rebuild a matchup string with the new field AND (for regular-league "@"
    // matchups, which carry the sport) the new sport.
    function rebuilt(p) {
      if (changeSport) p.sport = newSport;
      return PEFC.rebuildMatchup(p, newField);
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
            if (a && isTargetObj(a)) { a.field = newField; if (changeSport) a.sport = newSport; changed = true; }
          });
        }
      }
      if (changed) touchedBunks.push(bunk);
    }

    // (2) leagueAssignments[div]: scan every slot key (string arrays + structured).
    var la = (window.leagueAssignments && window.leagueAssignments[ctx.divName]) || null;
    if (la) {
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
              if (isTargetObj(item)) { item.field = newField; if (changeSport) item.sport = newSport; }
            }
          }
        });
      });
    }

    // (3) Specialty history gameLog — best-effort (drives the bracket/print).
    if (ctx.kind === 'specialty') {
      try { updateSpecialtyGameLog(ctx, newField); } catch (e) { console.warn('[PEFC] gameLog update skipped:', e); }
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

  function updateSpecialtyGameLog(ctx, newField) {
    if (typeof window.loadGlobalSettings !== 'function' || typeof window.saveGlobalSettings !== 'function') return;
    var gs = window.loadGlobalSettings() || {};
    var history = gs.specialtyLeagueHistory;
    if (!history || !history.gameLog) return;
    // Resolve league id from name via configured specialty leagues.
    var leagues = gs.specialtyLeagues || [];
    var league = leagues.filter(function (l) { return norm(l.name) === norm(ctx.leagueName); })[0];
    var id = league ? league.id : null;
    var date = window.currentScheduleDate;
    if (!id || !date || !history.gameLog[id] || !history.gameLog[id][date]) return;
    var entries = history.gameLog[id][date];
    var hit = false;
    entries.forEach(function (g) {
      // ctx.game.field is still the OLD field here (reset to newField later).
      if (sameTeams({ teamA: g.tA, teamB: g.tB }, ctx.game) && norm(g.field) === norm(ctx.game.field)) {
        g.field = newField; hit = true;
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
    ov.onclick = function (e) { if (e.target === ov) closeModal(); };
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:12px;padding:22px;min-width:380px;max-width:460px;box-shadow:0 20px 60px rgba(0,0,0,0.3);max-height:80vh;overflow:auto;';
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

  function showGamePicker(ctx) {
    var rows = ctx.games.map(function (g, i) {
      return '<button class="pefc-game" data-i="' + i + '" style="display:block;width:100%;text-align:left;padding:11px 13px;margin-bottom:8px;border:1.5px solid #e5e7eb;border-radius:9px;background:#f9fafb;cursor:pointer;font-size:0.92rem;">' +
        '<div style="font-weight:600;color:#1f2937;">' + esc(g.teams) + '</div>' +
        '<div style="font-size:0.8rem;color:#6b7280;margin-top:2px;">' +
        (g.sport ? esc(g.sport) + ' · ' : '') + 'Currently: <strong>' + esc(g.field || '—') + '</strong></div></button>';
    }).join('');
    var box = shell(header('Change a game\'s field') +
      '<div style="font-size:0.85rem;color:#6b7280;margin-bottom:12px;">' + esc(ctx.leagueName || 'League') + ' — pick the game to move:</div>' +
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

    var freeHtml = freeOnes.length
      ? freeOnes.map(function (c) {
        var isCur = norm(c.name) === norm(ctx.game.field);
        return '<button class="pefc-field" data-f="' + esc(c.name) + '" ' + (isCur ? 'disabled' : '') +
          ' style="padding:8px 13px;margin:0 8px 8px 0;border:1.5px solid ' + (isCur ? '#cbd5e1' : '#86efac') + ';border-radius:8px;background:' + (isCur ? '#f1f5f9' : '#f0fdf4') + ';color:' + (isCur ? '#94a3b8' : '#065f46') + ';font-size:0.85rem;font-weight:500;cursor:' + (isCur ? 'default' : 'pointer') + ';">' +
          esc(c.name) + (isCur ? ' (current)' : '') + (c.capacity > 1 ? ' <span style="opacity:0.6;font-size:0.75rem;">(cap:' + c.capacity + ')</span>' : '') + '</button>';
      }).join('')
      : '<div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px;font-size:0.85rem;color:#78350f;">No free fields for this game at this time. Free up a field first.</div>';

    // Don't list the game's own current field as "in use" (it's just where the
    // game already is). Everything else busy is genuinely occupied/blocked.
    var busyReal = busyOnes.filter(function (c) { return !c.current; });
    var busyHtml = busyReal.length
      ? '<div style="margin-top:12px;font-size:0.78rem;color:#9ca3af;">In use: ' +
      busyReal.map(function (c) { return esc(c.name); }).join(', ') + '</div>'
      : '';

    // When a sport change is pending, offer to apply it WITHOUT moving fields.
    var sportChanged = canEditSport && norm(curSport) !== norm(ctx.game.sport || '');
    var keepFieldHtml = sportChanged
      ? '<button id="pefc-keep-field" style="width:100%;margin-top:12px;padding:9px;border:1.5px solid #6366f1;border-radius:8px;background:#eef2ff;color:#4338ca;font-size:0.85rem;font-weight:600;cursor:pointer;">Keep ' + esc(ctx.game.field || 'current field') + ' — just change sport to ' + esc(curSport) + '</button>'
      : '';

    var box = shell(header('Move to which field?') +
      '<div style="background:#f3f4f6;padding:9px 12px;border-radius:8px;margin-bottom:14px;font-size:0.85rem;">' +
      '<div style="font-weight:600;color:#374151;">' + esc(ctx.game.teams) + '</div>' +
      '<div style="color:#6b7280;margin-top:2px;">' + (ctx.game.sport ? esc(ctx.game.sport) + ' · ' : '') + 'now on <strong>' + esc(ctx.game.field || '—') + '</strong></div></div>' +
      sportHtml +
      '<div style="font-weight:600;font-size:0.82rem;color:#166534;margin-bottom:8px;">Available fields' + (canEditSport ? ' for ' + esc(curSport) : '') + ':</div>' +
      '<div style="display:flex;flex-wrap:wrap;">' + freeHtml + '</div>' + busyHtml + keepFieldHtml +
      '<div style="display:flex;gap:10px;margin-top:18px;">' +
      (ctx.games.length > 1 ? '<button id="pefc-back" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;cursor:pointer;font-weight:500;">← Back</button>' : '') +
      '<button id="pefc-cancel" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;cursor:pointer;font-weight:500;">Cancel</button></div>');

    box.querySelector('#pefc-close').onclick = closeModal;
    box.querySelector('#pefc-cancel').onclick = closeModal;
    var back = box.querySelector('#pefc-back');
    if (back) back.onclick = function () { showGamePicker(ctx); };

    // Changing the sport re-filters the field list to fields that host it.
    var sportSel = box.querySelector('#pefc-sport');
    if (sportSel) sportSel.onchange = function () { ctx.selectedSport = sportSel.value; showFieldPicker(ctx); };

    var keepBtn = box.querySelector('#pefc-keep-field');
    if (keepBtn) keepBtn.onclick = function () {
      var res = PEFC.applyFieldChange(ctx, ctx.game.field, curSport);
      closeModal();
      toast(res.ok ? ('Changed sport: ' + res.message) : res.message, res.ok ? 'success' : 'warning');
    };

    box.querySelectorAll('.pefc-field').forEach(function (btn) {
      if (btn.disabled) return;
      btn.onclick = function () {
        var pickSport = canEditSport ? curSport : null;
        var res = PEFC.applyFieldChange(ctx, btn.dataset.f, pickSport);
        closeModal();
        toast(res.ok ? ('Moved: ' + res.message) : res.message, res.ok ? 'success' : 'warning');
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
