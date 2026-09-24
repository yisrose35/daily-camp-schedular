"""Parse the DML statements INSIDE plpgsql function bodies.

WHY THIS EXISTS. pglast parses a CREATE FUNCTION and treats its dollar-quoted body
as an opaque string literal, so nothing inside it is checked at all. A migration
can be entirely green under "does this file parse?" and still fail on the first
line Postgres actually reads. That is how `parse_workspace_key(kv.key).key` — a
plain syntax error, since that function returns text — reached the SQL editor.

WHAT IT DOES NOT DO. The statement splitter is naive: it breaks on ';' and then
finds where the DML starts. That is good enough for bodies written in the style of
193/195 and produces false positives on others — an INSERT ... ON CONFLICT DO
UPDATE spanning a semicolon inside a string literal comes out as a fragment. So
this is pointed at named files rather than run across all 155 migrations; a
checker that cried wolf on legacy files is a checker somebody switches off.

Making it general would mean a real plpgsql parser, which is its own project.
"""
import re, sys, pglast

def bodies(sql):
    """Every dollar-quoted function body in the file."""
    return [m.group(1) for m in re.finditer(r'AS \$\$(.*?)\$\$;', sql, re.S)]

def statements(body):
    """The pure-SQL DML statements in a plpgsql body.

    Splits on ';' then SEARCHES each chunk for where the DML begins, rather than
    requiring the chunk to start with it — a chunk routinely opens with leading
    comment lines or the tail of a preceding END IF / END LOOP, and anchoring on
    the start silently skipped exactly the statements worth checking.

    Skips plpgsql-only forms: SELECT ... INTO, GET DIAGNOSTICS, assignments.
    """
    out = []
    # Comments first. 'FOR UPDATE on the registry' in a comment is not an UPDATE,
    # and searching before stripping turned prose into a parse failure.
    body = '\n'.join(re.sub(r'--.*$', '', ln) for ln in body.split('\n'))
    # Splitting on ';' cuts a string literal that contains one in half, and the
    # halves then fail as "unterminated quoted string" — a false failure on real,
    # valid SQL (migration 182 had one). Rejoin chunks until the quotes balance.
    chunks, pending = [], ''
    for part in body.split(';'):
        pending = part if pending == '' else pending + ';' + part
        if pending.count("'") % 2 == 0:
            chunks.append(pending)
            pending = ''
    if pending:
        chunks.append(pending)
    for raw in chunks:
        # A row-locking clause is not a statement. `SELECT ... FOR UPDATE` used to
        # match on the word UPDATE, leaving `s` as the bare token "UPDATE", which
        # pglast reports as "syntax error at end of input" — so this script FAILED
        # on 168, 172 and 178, the three files with the most money in them, and
        # had been doing so silently. Take the first match that is a real
        # statement, skipping FOR UPDATE and FOR NO KEY UPDATE.
        m = None
        for cand in re.finditer(r'\b(UPDATE|INSERT INTO|DELETE FROM)\b', raw, re.I):
            before = raw[:cand.start()]
            # Inside a string literal, so it is not a statement in this body —
            # it is dynamic SQL built for EXECUTE, and its %I/%s placeholders are
            # not valid SQL until format() has filled them in. Checking it here
            # reports a syntax error in a template, which is a false failure on
            # correct code: 222's purge loop tripped exactly this. The chunk
            # splitter above already rejoins until quotes balance, so an odd
            # count before the match means the match is inside one.
            if before.count("'") % 2 == 1:
                continue
            before = before.rstrip().upper()
            if before.endswith('FOR') or before.endswith('FOR NO KEY'):
                continue
            m = cand
            break
        if not m:
            continue
        s = raw[m.start():].strip()
        if not s:
            continue
        # Drop comment-only lines inside the statement; pglast handles them, but
        # they make failures unreadable.
        if ':=' in s:
            continue
        if re.match(r'^SELECT', s, re.I):
            continue
        # `RETURNING <expr> INTO <vars>` is plpgsql, not SQL, so pglast rejects a
        # perfectly good INSERT for its tail. Drop the INTO clause and check the
        # statement that remains. This was failing on 23 files — every trigger
        # that inserts a row and keeps its id — so those bodies were never
        # checked at all.
        s = re.sub(r'(\bRETURNING\b[\s\S]*?)\bINTO\b[\s\S]*$', r'\1', s, flags=re.I).strip()
        if not s:
            continue
        out.append(s)
    return out

def check(path):
    sql = open(path).read()
    bad = []
    for body in bodies(sql):
        for stmt in statements(body):
            try:
                pglast.parse_sql(stmt)
            except Exception as e:
                bad.append((stmt.split('\n')[0][:90], str(e).split('\n')[0]))
    return bad

if __name__ == '__main__':
    failed = False
    for path in sys.argv[1:]:
        bad = check(path)
        print('%-46s %s' % (path.split('/')[-1],
                            'ok (%d bodies)' % len(bodies(open(path).read()))
                            if not bad else 'FAILED'))
        for stmt, err in bad:
            print('    %s\n      -> %s' % (stmt, err)); failed = True
    sys.exit(1 if failed else 0)
