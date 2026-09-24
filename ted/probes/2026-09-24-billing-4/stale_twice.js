// Can two callers both take the same stale charge claim (268)? After a retake the
// claim keeps its OLD called_at, so it still looks stale to the next caller.
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5498 });
const C = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a4a8', O = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b4b8';
const q = s => db.sql(s).trim().split('\n').pop();
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${O}','o@t'); INSERT INTO camps (id, owner, name) VALUES ('${C}', '${O}', 'T');`);
  console.log('parent try 1 :', q(`SELECT claim_charge_intent('${C}','deposit:e1:25000',250,'e1')::text;`));
  q(`SELECT mark_charge_intent_called('${C}','deposit:e1:25000');`);
  // Cardknox connection drops: claim stays; 11 minutes pass
  q(`UPDATE refund_intents SET called_at = now() - interval '11 minutes', created_at = now() - interval '11 minutes' WHERE key='deposit:e1:25000'; SELECT 1;`);
  console.log('parent try 2 :', q(`SELECT claim_charge_intent('${C}','deposit:e1:25000',250,'e1')::text;`));
  console.log('office confirm (click 1):', q(`SELECT claim_charge_intent('${C}','deposit:e1:25000',250,'e1',true)::text;`));
  console.log('office confirm (click 2, before click 1 reached the processor):', q(`SELECT claim_charge_intent('${C}','deposit:e1:25000',250,'e1',true)::text;`));
  console.log('parent try 3 meanwhile:', q(`SELECT claim_charge_intent('${C}','deposit:e1:25000',250,'e1')::text;`));
} finally { db.stop && db.stop(); }
