// Probe (5th pass): TED-089 end to end on the real 271 functions, plus the one
// ordering 271 leaves open: the office's page had pulled the application in
// (drain, not saved) BEFORE the parent paid, and saves the settings document
// AFTER. The cloud document had no copy of the application to merge from, so
// the page writes its pre-payment copy there. Which copy do the deposit
// functions believe?
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5512 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a512', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b512';
const q = s => db.sql(s).trim().split('\n').pop();
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'T', 'cardknox');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', '{"enrollments":{}}'::jsonb);
    INSERT INTO camp_applications (camp_id, kind, entry_id, payload) VALUES ('${CAMP}','enrollments','e9',
      '{"camperName":"New Kid","status":"applied","depositRequired":250}'::jsonb);`);
  const owed = () => q(`SELECT _registration_deposit_owed('${CAMP}','e9')::text;`);
  console.log('1 owed before paying        :', owed());
  console.log('2 Cardknox deposit 9001     :', q(`SELECT _record_registration_deposit('${CAMP}','e9',250,'9001')::text;`));
  console.log('3 owed after                :', owed());
  console.log('4 same ref again (webhook)  :', q(`SELECT _record_registration_deposit('${CAMP}','e9',250,'9001')::text;`));
  console.log('  camp_applications copy    :', q(`SELECT payload - 'camperName' - 'status' FROM camp_applications WHERE camp_id='${CAMP}' AND entry_id='e9';`));
  // the office's tab had the pre-payment copy in memory and now saves the document
  q(`UPDATE camp_state_kv SET value = jsonb_set(value, '{enrollments,e9}', '{"camperName":"New Kid","status":"accepted","depositRequired":250}'::jsonb) WHERE camp_id='${CAMP}' AND key='campistryMe'; SELECT 1;`);
  console.log('5 after the old tab saved the document:');
  console.log('  owed                      :', owed());
  console.log('  record a DIFFERENT charge 9002 (a second payment of the same deposit):', q(`SELECT _record_registration_deposit('${CAMP}','e9',250,'9002')::text;`));
  console.log('  camp_applications copy now:', q(`SELECT payload->'depositCharges' FROM camp_applications WHERE camp_id='${CAMP}' AND entry_id='e9';`));
} finally { db.stop && db.stop(); }
