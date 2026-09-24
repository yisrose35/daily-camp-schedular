// A parent submits the registration form (200: the application is a camp_applications
// row until the office's browser absorbs it) and is then asked to pay the deposit.
// What do the deposit functions (185/190, read campistryMe.enrollments only) say?
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5500 });
const C = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a500', O = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b500';
const q = s => db.sql(s).trim().split('\n').pop();
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${O}','o@t'); INSERT INTO camps (id, owner, name) VALUES ('${C}', '${O}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}','campistryMe','{"sessions":[{"name":"Full","tuition":1000}],"enrollments":{}}'::jsonb);`);
  console.log('submit:', q(`SELECT submit_public_application('${C}','enrollments','enr_3f9c2a7b1d4e4c8a9b0f6e5d2c1a7b3e','{"camperName":"New Kid","session":"Full","status":"applied","depositRequired":250}'::jsonb)::text;`));
  console.log('row in camp_applications:', q(`SELECT count(*) FROM camp_applications WHERE camp_id='${C}' AND entry_id='enr_3f9c2a7b1d4e4c8a9b0f6e5d2c1a7b3e';`));
  console.log('_registration_deposit_owed :', q(`SELECT _registration_deposit_owed('${C}','enr_3f9c2a7b1d4e4c8a9b0f6e5d2c1a7b3e')::text;`));
  console.log('_record_registration_deposit (what the webhook calls after Stripe took $250):', q(`SELECT _record_registration_deposit('${C}','enr_3f9c2a7b1d4e4c8a9b0f6e5d2c1a7b3e',250,'pi_dep_1')::text;`));
} finally { db.stop && db.stop(); }
