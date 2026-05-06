// Open this file in your editor (NOT the terminal), select-all, copy, paste into browser console.
(function () {
  function fmt(m) {
    var h = Math.floor(m / 60);
    var mm = m % 60;
    var ap = h < 12 ? 'am' : 'pm';
    var hh = ((h + 11) % 12) + 1;
    return hh + ':' + String(mm).padStart(2, '0') + ap;
  }

  function isChangeish(s) {
    var a = String(s._activity || s.activity || s.event || s.name || '').toLowerCase();
    if (a.indexOf('change') >= 0) return true;
    if (s._swimChange) return true;
    if (s.type === 'pre-change') return true;
    if (s.type === 'post-change') return true;
    if (s.type === 'change') return true;
    return false;
  }

  function describe(s, src, label) {
    return {
      where: src,
      who: label,
      time: fmt(s.startMin) + '-' + fmt(s.endMin),
      type: s.type,
      activity: s._activity || s.activity || s.event,
      source: s._source,
      swimChange: s._swimChange,
      isChange: isChangeish(s)
    };
  }

  var hits = [];

  // _perBunkSlots
  var dt = window.divisionTimes || {};
  Object.keys(dt).forEach(function (g) {
    var pbs = (dt[g] && dt[g]._perBunkSlots) || {};
    Object.keys(pbs).forEach(function (b) {
      (pbs[b] || []).forEach(function (s) {
        if (isChangeish(s)) hits.push(describe(s, '_perBunkSlots', 'G' + g + '/B' + b));
      });
    });
  });

  // scheduleAssignments
  var sa = window.scheduleAssignments || {};
  Object.keys(sa).forEach(function (b) {
    (sa[b] || []).forEach(function (s) {
      if (isChangeish(s)) hits.push(describe(s, 'scheduleAssignments', 'B' + b));
    });
  });

  // bunkTimelines
  var bt = window.bunkTimelines || {};
  Object.keys(bt).forEach(function (b) {
    (bt[b] || []).forEach(function (s) {
      if (isChangeish(s)) hits.push(describe(s, 'bunkTimelines', 'B' + b));
    });
  });

  console.log('TOTAL CHANGE HITS:', hits.length);
  console.table(hits.slice(0, 60));

  // Swim layer pre/post values currently loaded
  console.log('--- daAutoLayers swim layers ---');
  var dal = window.daAutoLayers || {};
  Object.keys(dal).forEach(function (g) {
    (dal[g] || []).forEach(function (L) {
      var act = String(L.activity || L.name || '').toLowerCase();
      if (act.indexOf('swim') >= 0) {
        console.log('G' + g + ' "' + L.name + '" pre=' + (L.preChangeMin || 0) + ' post=' + (L.postChangeMin || 0));
      }
    });
  });
})();
