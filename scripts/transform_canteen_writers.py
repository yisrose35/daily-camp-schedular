#!/usr/bin/env python3
"""
Move the canteen writers off the camp-wide document lock and onto one row per
camper, by RULE rather than by hand.

WHY A TRANSFORMER. Thirteen functions, ~1,500 lines, all doing the same five
things around money arithmetic that must not change by a single character.
Retyping them is thirteen chances to alter a number; a rule that is applied
uniformly and then DIFFED is one chance, and the diff shows it.

WHY THE RULES ARE SCOPED TO ONE KEY. submit_shop_order and settle_shop_order
lock campistryShop as well as campistrySnacks. The shop is not being converted,
so its lock must survive untouched. A rule that is uniform across a FILE is not
uniform across the KEYS that file touches — that mistake cost three near-misses
in 214/215, including stripping locks that were load-bearing. So every pattern
here names 'campistrySnacks' explicitly, and the leftover report names the KEY
it found, not just the function.

WHAT IT REFUSES TO DO. A function that still holds a campistrySnacks lock after
transformation, or that wrote accounts before and saves none after, fails the
run. Silence is not success.

  python3 scripts/transform_canteen_writers.py            # report
  python3 scripts/transform_canteen_writers.py --emit     # print converted SQL
"""
import re, sys, pathlib, collections

MIG = pathlib.Path(__file__).resolve().parent.parent / 'migrations'
OUTPUT_AT = 219          # never read our own output back in

TARGETS = [
    'credit_canteen_balance_from_processor', 'credit_canteen_balance_from_stripe',
    'merge_canteen_autoreload_card', 'refund_canteen_deposit_from_processor',
    'refund_canteen_deposit_from_stripe', 'set_canteen_auto_reload', 'set_canteen_limits',
    'settle_shop_order', 'submit_canteen_deposit', 'submit_canteen_purchase',
    'submit_shop_order', 'update_canteen_autoreload_state',
    'use_family_card_for_canteen_auto_reload',
]


def migration_number(p):
    m = re.match(r'(\d+)', p.name)
    return int(m.group(1)) if m else 0


def latest_definitions():
    """Each function's CURRENT definition — the last one to be applied wins."""
    out = {}
    for f in sorted(MIG.glob('*.sql'), key=migration_number):
        if f.name.startswith('APPLY') or migration_number(f) >= OUTPUT_AT:
            continue
        s = f.read_text(errors='ignore')
        for m in re.finditer(r'CREATE OR REPLACE FUNCTION\s+(?:public\.)?(\w+)\s*\(', s):
            start = m.start()
            end = s.find('\n$$;', start)
            if end < 0:
                continue
            out[m.group(1)] = (f.name, s[start:end + 4])
    return out


# ── the rules ───────────────────────────────────────────────────────────────
# Every one names campistrySnacks. None of them can match a campistryShop
# statement, which is the entire reason the shop writers are safe to run
# through this.

# R1 — the create-if-missing INSERT. canteen_account_lock() creates the row, so
#      the document no longer needs seeding on a camper's first purchase.
R1 = re.compile(
    r'[ \t]*INSERT INTO camp_state_kv \(camp_id, key, value, updated_at\)\s*\n'
    r'[ \t]*VALUES \([^;]*?\'campistrySnacks\'[^;]*?ON CONFLICT \(camp_id, key\) DO NOTHING;[ \t]*\n',
    re.S)

# R2 — THE LOCK. `SELECT value INTO <var> ... key='campistrySnacks' ... FOR
#      UPDATE` becomes a lock on one camper's row. The <var> keeps its name so
#      nothing downstream has to be renamed; it simply stops being the camp's
#      document and starts being unused.
R2 = re.compile(
    r'[ \t]*SELECT value INTO (?P<var>\w+)\s*\n?'
    r'\s*FROM camp_state_kv\s*\n?'
    r'\s*WHERE camp_id = (?P<camp>[\w.]+) AND key = \'campistrySnacks\'\s*\n?'
    r'\s*FOR UPDATE;[ \t]*\n',
    re.S)

# R3 — the defensive branch initialisers that only existed to make the document
#      safe to jsonb_set into.
R3_PATTERNS = [
    r'[ \t]*IF (?P<v>\w+) IS NULL THEN (?P=v) := \'\{"accounts":\{\},"transactions":\[\]\}\'::jsonb; END IF;[ \t]*\n',
    r'[ \t]*IF \w+->\'accounts\' IS NULL THEN \w+ := jsonb_set\(\w+, \'\{accounts\}\', \'\{\}\'::jsonb\); END IF;[ \t]*\n',
    r'[ \t]*IF \w+->\'transactions\' IS NULL THEN \w+ := jsonb_set\(\w+, \'\{transactions\}\', \'\[\]\'::jsonb\); END IF;[ \t]*\n',
    r'[ \t]*IF (?P<w>\w+) IS NULL THEN\s*\n[ \t]*(?P=w) := \'\{"accounts":\{\},"transactions":\[\]\}\'::jsonb;\s*\n[ \t]*END IF;[ \t]*\n',
    # The four-argument create-if-missing form, spread over three lines. Left
    # behind, its bare mention of '{transactions}' is enough to trip the
    # refusals below — which is how settle_shop_order looked like an
    # unconverted ledger writer when its ledger write was in fact fine.
    r'[ \t]*IF \w+->\'(?:accounts|transactions)\' IS NULL THEN\s*\n'
    r'[ \t]*\w+ := jsonb_set\(\w+, \'\{(?:accounts|transactions)\}\', \'(?:\{\}|\[\])\'::jsonb, true\);\s*\n'
    r'[ \t]*END IF;[ \t]*\n',
    # ...and the single-line four-argument form.
    r'[ \t]*IF \w+->\'(?:accounts|transactions)\' IS NULL THEN \w+ := jsonb_set\(\w+, '
    r'\'\{(?:accounts|transactions)\}\', \'(?:\{\}|\[\])\'::jsonb, true\); END IF;[ \t]*\n',
]

# R8 — NESTED account paths. update_canteen_autoreload_state does not replace
#      the account object; it reaches into it:
#
#        v_value #> ARRAY['accounts', name, 'autoReload']
#        jsonb_set(v_value, ARRAY['accounts', name, 'autoReload', 'disabledAt'], ...)
#
#      Those become operations on the locked account itself, with the leading
#      two elements — which only ever existed to navigate the document — cut
#      off. The account's own shape is untouched.
R8_SET = re.compile(
    r'jsonb_set\(\s*(?P<var>\w+),\s*ARRAY\[\'accounts\', (?P<name>[^,\]]+),\s*(?P<rest>[^\]]+)\]',
    re.S)
R8_GET = re.compile(
    r'(?P<var>\w+) #> ARRAY\[\'accounts\', (?P<name>[^,\]]+),\s*(?P<rest>[^\]]+)\]',
    re.S)

# R4 — the account write. jsonb_set(doc, ARRAY['accounts', <name>], <expr>)
#      becomes a save of <expr> against that camper's row. <expr> is carried
#      through untouched: it is the money.
R4 = re.compile(
    r'[ \t]*(?P<var>\w+) := jsonb_set\(\s*(?P=var),\s*ARRAY\[\'accounts\', (?P<name>[^\]]+)\],\s*'
    r'(?P<expr>.*?),\s*true\s*\);[ \t]*\n',
    re.S)

# R5 — the final UPDATE of the document. Nothing left to write.
R5 = re.compile(
    r'[ \t]*UPDATE camp_state_kv\s*\n?\s*SET value = \w+, updated_at = [\w_()]+\s*\n?'
    r'\s*WHERE camp_id = [\w.]+ AND key = \'campistrySnacks\';[ \t]*\n',
    re.S)

# R6 — the ledger. The new transaction is the object inside the jsonb_build_array
#      that gets prepended; the rest of the expression is the old list, which the
#      rows no longer need.
R6 = re.compile(
    r'[ \t]*(?P<var>\w+) := jsonb_set\(\s*(?P=var),\s*\'\{transactions\}\',\s*'
    r'jsonb_build_array\(\s*(?P<tx>jsonb_build_object\(.*?\))\s*\)\s*\|\|.*?\);[ \t]*\n',
    re.S)

# R7 — the duplicate guard. Every credit and refund path asks "have I already
#      recorded this processor reference?" by scanning the document's
#      transactions array. That array is gone, so the question has to be put to
#      the ledger table instead.
#
#      This is the single most dangerous statement in the whole conversion. It
#      is what stops a retried webhook crediting a camper twice, and against a
#      NULL document it silently answers "no". Converted it becomes STRONGER
#      than it was: canteen_transactions has a primary key, an index, and rows
#      that outlive any one document save.
#      The trailing WHERE is consumed deliberately: the camp scope and the
#      original predicate have to join with AND. Emitting the scope and leaving
#      the old WHERE in place produced two WHERE clauses and a syntax error —
#      which, of the ways this could have gone wrong, is much the best one,
#      because the alternative is a duplicate guard that runs unscoped and
#      matches another camp's reference.
R7 = re.compile(
    r'SELECT 1 FROM jsonb_array_elements\(\s*(?:COALESCE\()?\w+->\'transactions\''
    r'(?:,\s*\'\[\]\'::jsonb\))?\s*\) t\s*WHERE\s+',
    re.S)


def transform(fn, body):
    """Returns (new_body, notes). Raises on anything it cannot do safely."""
    notes = []
    camp = None
    name = None

    m = R2.search(body)
    if not m:
        raise RuntimeError(f'{fn}: no campistrySnacks FOR UPDATE found to replace')
    camp = m.group('camp')

    # The camper this function is about, taken from the account write itself so
    # it is never guessed.
    m4 = R4.search(body)
    if not m4:
        raise RuntimeError(f'{fn}: locks campistrySnacks but never writes an account')
    name = m4.group('name').strip()

    out = R1.sub('', body)
    out = R2.sub(
        lambda mm: (f"    -- 219: one camper's row, not the camp's document.\n"
                    f"    {mm.group('var')} := NULL::jsonb;  -- document no longer read\n"
                    f"    v_locked_acct := public.canteen_account_lock({camp}, {name});\n"),
        out, count=1)
    for pat in R3_PATTERNS:
        out = re.sub(pat, '', out, flags=re.S)

    # The per-ACCOUNT create-if-missing: "if this camper has no account yet,
    # put a default one in the document". canteen_account_lock does exactly
    # that now, against the row. Removed only when the block really is that —
    # the guard on ARRAY['accounts' is what stops this eating an unrelated
    # IF that happens to test an account field.
    def drop_account_seed(mm):
        return '' if "ARRAY['accounts'" in mm.group(0) else mm.group(0)
    out = re.sub(
        r"[ \t]*IF \w+->'accounts'->[\w.]+ IS NULL THEN\s*\n(?:[^\n]*\n)*?[ \t]*END IF;[ \t]*\n",
        drop_account_seed, out)

    def save(mm):
        return (f"    PERFORM public.canteen_account_save({camp}, {name},\n"
                f"        {mm.group('expr').strip()});\n")
    out, n4 = R4.subn(save, out)

    # Nested-path writers reach INTO the account rather than replacing it, so
    # they never match R4. Their edits are re-aimed at the locked object and
    # the single save happens where the document UPDATE used to be.
    out, n8a = R8_SET.subn(lambda mm: f"jsonb_set(v_locked_acct, ARRAY[{mm.group('rest')}]", out)
    out, n8b = R8_GET.subn(lambda mm: f"v_locked_acct #> ARRAY[{mm.group('rest')}]", out)
    if n8a or n8b:
        out = re.sub(r'\b(\w+) := jsonb_set\(v_locked_acct,', 'v_locked_acct := jsonb_set(v_locked_acct,', out)
        notes.append(f'{n8a + n8b} nested account edit(s)')

    if n4 == 0 and not (n8a or n8b):
        raise RuntimeError(f'{fn}: account write not converted')
    if n4:
        notes.append(f'{n4} account save(s)')

    out, n6 = R6.subn(
        lambda mm: (f"    PERFORM public.canteen_post({camp}, {name},\n"
                    f"        {mm.group('tx').strip()});\n"),
        out)
    if n6:
        notes.append(f'{n6} ledger post(s)')

    # The duplicate guard, re-aimed at the ledger. `t` keeps its alias so the
    # WHERE clause that follows — which names the processor's own reference —
    # is carried through untouched: that predicate is the idempotency rule and
    # rewriting it would be rewriting the money.
    out, n7 = R7.subn(
        f"SELECT 1 FROM canteen_transactions t\n         WHERE t.camp_id = {camp} AND ", out)
    if n7:
        # The original read t->>'field'; the row's copy of that object is payload.
        out = re.sub(r"\bt->>'", "t.payload->>'", out)
        notes.append(f'{n7} duplicate guard(s) re-aimed at the ledger')

    # The document UPDATE. For a writer that replaced the whole account, R4 has
    # already emitted the save and this is simply dead. For a nested-path
    # writer, this IS where the one save belongs — it is the moment the
    # original committed its edits.
    if n4:
        out = R5.sub('', out)
    else:
        out, n5 = R5.subn(
            f"    PERFORM public.canteen_account_save({camp}, {name}, v_locked_acct);\n", out)
        if n5 == 0:
            raise RuntimeError(f'{fn}: nested edits made but no document UPDATE to save at')
        notes.append('save at the former document UPDATE')

    # The account object now comes from the lock, not from the document.
    out = re.sub(r"COALESCE\(\w+->'accounts'->" + re.escape(name) + r",\s*",
                 'COALESCE(v_locked_acct, ', out)
    out = re.sub(r"\(\w+->'accounts'->" + re.escape(name) + r"->>'(\w+)'\)::numeric",
                 r"(v_locked_acct->>'\1')::numeric", out)
    out = re.sub(r"COALESCE\(\w+->'accounts',\s*'\{\}'::jsonb\)",
                 "jsonb_build_object(" + name + ", COALESCE(v_locked_acct, '{}'::jsonb))", out)

    # A declaration for the handle the rules introduce.
    out = re.sub(r'(\nDECLARE\n)', r"\1    v_locked_acct jsonb;\n", out, count=1)

    # ── refusals ────────────────────────────────────────────────────────────
    # These exist because the first version of this script reported "13/13
    # converted" while emitting code that silently lost money.
    #
    # R2 sets the document variable to NULL, and R5 deletes the UPDATE that
    # would have written it. So ANY surviving reference to the document is not
    # a leftover to tidy later — it is a live bug with no error attached:
    #
    #   jsonb_set(v_value, '{transactions}', ...)  on NULL yields NULL, and
    #   with the UPDATE gone the transaction is simply never recorded.
    #
    #   SELECT 1 FROM jsonb_array_elements(v_value->'transactions') — the
    #   duplicate-detection guard in every credit and refund path — finds
    #   nothing in NULL and passes. A retried webhook credits twice.
    #
    # Both were present in the first run's output for four money functions.
    leftover = re.search(r"'campistrySnacks'[^;]*FOR UPDATE", out, re.S)
    if leftover:
        raise RuntimeError(f'{fn}: still locks campistrySnacks after transformation')
    if "canteen_account_save" not in out:
        raise RuntimeError(f'{fn}: wrote an account before and saves none now')

    if re.search(r"'\{transactions\}'", out):
        raise RuntimeError(
            f'{fn}: still writes the document ledger — that write now lands on NULL '
            'and the transaction is lost silently')
    if re.search(r"->\s*'transactions'", out):
        raise RuntimeError(
            f'{fn}: still READS the document ledger — this is the duplicate guard, '
            'and against NULL it passes, so a retried call credits twice')
    if re.search(r"->\s*'accounts'", out):
        raise RuntimeError(
            f'{fn}: still reads the document accounts branch, which is now NULL')

    # Every ledger write in the original must have become a post. Counting is
    # not optional: a ledger write that vanished leaves the money moved and no
    # record of why.
    wrote_ledger = len(re.findall(r"'\{transactions\}'", body))
    if wrote_ledger and not re.search(r'canteen_post', out):
        raise RuntimeError(
            f'{fn}: wrote {wrote_ledger} ledger entr(y/ies) before and posts none now')
    return out, notes


def main():
    emit = '--emit' in sys.argv
    latest = latest_definitions()
    ok, failed = [], []
    chunks = []
    for fn in TARGETS:
        if fn not in latest:
            failed.append((fn, 'not found in migrations')); continue
        src_file, body = latest[fn]
        try:
            new, notes = transform(fn, body)
        except RuntimeError as e:
            failed.append((fn, str(e))); continue
        ok.append((fn, src_file, notes))
        chunks.append(new)

    for fn, f, notes in ok:
        print(f'  ok    {fn:42s} {", ".join(notes)}  [{f}]')
    for fn, why in failed:
        print(f'  FAIL  {fn:42s} {why}')
    print(f'\n{len(ok)}/{len(TARGETS)} converted')

    # Anything still holding the camp-wide snacks lock anywhere, named by KEY.
    leftovers = collections.Counter()
    for fn, (f, body) in latest.items():
        for key in re.findall(r"'(campistry\w+)'[^;]{0,400}?FOR UPDATE", body, re.S):
            if fn not in [o[0] for o in ok]:
                leftovers[(fn, key)] += 1
    if leftovers:
        print('\nstill locking a whole document (not converted by this run):')
        for (fn, key), n in sorted(leftovers.items()):
            print(f'    {fn:42s} {key}')

    if emit:
        pathlib.Path('/tmp/canteen_writers.sql').write_text('\n\n'.join(chunks))
        print('\nwritten to /tmp/canteen_writers.sql')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
