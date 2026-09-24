// Check that the read-only query in the report's owner step 1 runs on the real schema.
const R = '/home/user/daily-camp-schedular', fs = require('fs');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5516 });
try {
  const rep = fs.readFileSync(R + '/ted/reports/2026-09-24-billing-fifth-pass.md', 'utf8');
  const sql = rep.match(/`(select camp_id, entry_id[^`]+)`/)[1];
  db.sql(`INSERT INTO auth.users (id,email) VALUES ('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b516','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a516','b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b516','T');
    INSERT INTO camp_state_kv (camp_id,key,value) VALUES ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a516','campistryMe','{"enrollments":{"e1":{"camperName":"A","depositPaid":250,"depositReference":"pi_1"}}}');
    INSERT INTO camp_applications (camp_id,kind,entry_id,payload) VALUES ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a516','enrollments','e2','{"camperName":"B","depositPaid":250,"depositReference":"9001"}');`);
  console.log(db.sql(sql));
} finally { db.stop && db.stop(); }
