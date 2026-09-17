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
    for raw in body.split(';'):
        m = re.search(r'\b(UPDATE|INSERT INTO|DELETE FROM)\b', raw, re.I)
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
