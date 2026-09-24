// Proof: record_processor_transaction with the kinds the edge functions send.
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5477 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a3a7';
try {
  db.sql(`INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', gen_random_uuid(), 'T');`);
  for (const k of ['charge', 'registration_deposit', 'registration_card_capture']) {
    let out;
    try { out = db.sql(`SELECT record_processor_transaction('${CAMP}','cardknox','ref_${k}','${k}',25000,'succeeded',NULL)::text;`).trim(); }
    catch (e) { out = 'ERROR: ' + String(e.message || e).split('\n').find(l => /ERROR/.test(l)); }
    console.log(k, '=>', out);
  }
  console.log('rows:', db.sql(`SELECT string_agg(kind, ', ') FROM processor_transactions WHERE camp_id='${CAMP}'`).trim());
} finally { db.stop && db.stop(); }
