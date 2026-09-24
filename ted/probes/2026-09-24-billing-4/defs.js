// Dump current function definitions from the migration chain (read-only helper).
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5494 });
try {
  for (const n of process.argv.slice(2)) console.log(db.sql(`SELECT pg_get_functiondef('${n}'::regprocedure);`));
} finally { db.stop && db.stop(); }
