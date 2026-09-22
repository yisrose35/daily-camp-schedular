#!/usr/bin/env python3
"""Mechanically move the family writers off the camp document.

WHY A SCRIPT. Nineteen functions took `SELECT ... FOR UPDATE` on
camp_state_kv(campistryMe) to edit one family inside it — 2,375 lines in total.
Hand-transcribing that many lines of money logic is where a silent error hides:
it would not be a syntax error, it would be a wrong number on a family's bill.
So the transformation is applied by rule, and a test diffs every result against
its original and fails on any line that is not part of an expected rule.

THE RULES, and what each replaces:
  R6  drop the "create the campistryMe row if missing" preamble — nothing is
      written to that row any more, so there is nothing to create.
  R1  drop `FOR UPDATE` — ONLY from the campistryMe read. See the warning below.
  R2  <doc>->'families'                  -> public.camp_families_object(camp)
  R3  <doc> #> ARRAY['families', K]      -> public.camp_family_for_update(camp, K)
  R4  <doc> := jsonb_set(<doc>, ARRAY['families', K], V)
                                         -> PERFORM public.camp_family_save(camp, K, V)
  R5  drop the `UPDATE camp_state_kv SET value = <doc>` for campistryMe.

THE BUG THIS SCRIPT ALREADY CAUGHT, and why R1 is narrow. The first version
stripped `FOR UPDATE` from EVERY camp_state_kv read. Three of those reads are of
campistryShop and campistrySnacks, in settle_shop_order and
use_family_card_for_canteen_auto_reload, and those blobs are still
read-modify-written — so the blanket rule would have introduced a lost update on
the shop and canteen ledgers. A rule that looks uniform across a file is not
uniform across the KEYS that file touches.

That is also why this script reports, per function, which rules fired and what it
could not handle, instead of silently emitting SQL. A leftover is a thing to look
at by hand, not a thing to suppress.

Usage:  python3 scripts/transform_family_writers.py           # report only
        python3 scripts/transform_family_writers.py --json    # dump the bodies
"""

import re, json, sys, os

DIR='migrations'
files=sorted([f for f in os.listdir(DIR) if re.match(r'^\d+_.*\.sql$',f)], key=lambda f:int(f[:3]))
latest={}
for f in files:
    src=open(os.path.join(DIR,f)).read()
    for m in re.finditer(r'CREATE OR REPLACE FUNCTION\s+public\.([a-z0-9_]+)\s*\(', src, re.I):
        end=src.find('\n$$;', m.end())
        if end<0: continue
        start=src.rfind('CREATE OR REPLACE FUNCTION', 0, m.end())
        latest[m.group(1)]=(f, src[start:end+4])

FAMILY_ONLY=['settle_shop_order','resolve_chargeback','merge_camp_family_fields',
 'append_family_payment_method','remove_payment_method','set_default_payment_method',
 'flag_expiring_cards','flag_plan_collection','use_family_card_for_canteen_auto_reload',
 '_admin_backfill_saved_payment_methods','_admin_clear_stale_byop_cards']

def camp_expr(body):
    """How this function names the camp id."""
    if re.search(r'\binv\.camp_id\b', body): return 'inv.camp_id'
    if re.search(r'\bp_camp_id\b', body): return 'p_camp_id'
    if re.search(r'\bv_camp\b', body): return 'v_camp'
    return None

report={}
for fn in FAMILY_ONLY:
    f, body = latest[fn]
    orig = body
    camp = camp_expr(body)
    applied=[]

    # R6: drop the "create the row if missing" preamble.
    n_before=body
    body = re.sub(r'[ \t]*INSERT INTO camp_state_kv \(camp_id, key, value, updated_at\)\n'
                  r'[ \t]*VALUES \([^\n]*\n[ \t]*ON CONFLICT \(camp_id, key\) DO NOTHING;\n',
                  '', body)
    if body!=n_before: applied.append('R6 drop-create')

    # R1: drop the lock — ONLY on the campistryMe read.
    #
    # A blanket strip removed it from campistryShop and campistrySnacks reads too,
    # in settle_shop_order and use_family_card_for_canteen_auto_reload. Those blobs
    # are still read-modify-written, so that would have introduced a lost update on
    # the shop and canteen ledgers: a money bug, from a rule that looked uniform.
    n_before=body
    def _unlock(m):
        seg=m.group(0)
        if "key = 'campistryMe'" not in seg:
            return seg
        return re.sub(r'\s*FOR UPDATE;', ';', seg)
    body = re.sub(r"SELECT value INTO \w+[\s\S]{0,260}?FOR UPDATE;", _unlock, body)
    if body!=n_before: applied.append('R1 drop-FOR-UPDATE(campistryMe only)')

    # R3: one family, by key, locked.
    n_before=body
    body = re.sub(r'(\w+) #> ARRAY\[\'families\', ([^\]]+)\]',
                  lambda m: f'public.camp_family_for_update({camp}, {m.group(2)})', body)
    if body!=n_before: applied.append('R3 one-family')

    # R2: the whole families object.
    n_before=body
    body = re.sub(r"COALESCE\((\w+)->'families', '\{\}'::jsonb\)",
                  lambda m: f'public.camp_families_object({camp})', body)
    body = re.sub(r"(\w+)\s*->\s*'families'",
                  lambda m: f'public.camp_families_object({camp})', body)
    if body!=n_before: applied.append('R2 all-families')

    # R4: write one family back.
    n_before=body
    body = re.sub(r'(\w+) := jsonb_set\(\1, ARRAY\[\'families\', ([^\]]+)\], ([^;]+?)(?:, true)?\);',
                  lambda m: f'PERFORM public.camp_family_save({camp}, {m.group(2)}, {m.group(3)});', body)
    if body!=n_before: applied.append('R4 save-family')

    # R5: drop the document write.
    n_before=body
    body = re.sub(r'[ \t]*UPDATE camp_state_kv SET value = \w+, updated_at = [^\n]*\n[ \t]*WHERE camp_id = [^\n]*?key = \'campistryMe\';\n',
                  '', body)
    body = re.sub(r'[ \t]*UPDATE camp_state_kv\s*\n[ \t]*SET value = \w+[^\n]*\n(?:[ \t]*[^\n]*\n)*?[ \t]*WHERE[^\n]*campistryMe\';\n',
                  '', body)
    if body!=n_before: applied.append('R5 drop-doc-write')

    code=re.sub(r'--[^\n]*','',body)
    leftovers=[]
    # Report by KEY. A lock or a write on campistryShop / campistrySnacks is
    # CORRECT and must survive — only campistryMe is being moved out. Reporting
    # those as leftovers made three correct functions look unfinished, which is
    # how a real leftover gets lost in the noise.
    for m in re.finditer(r"SELECT value INTO \w+[\s\S]{0,260}?key = '(\w+)'([\s\S]{0,30}?);", code):
        if m.group(1)=='campistryMe' and 'FOR UPDATE' in m.group(2):
            leftovers.append('campistryMe STILL LOCKED')
    for m in re.finditer(r'UPDATE camp_state_kv[\s\S]{0,260}?;', code):
        k=re.search(r"key = '(\w+)'", m.group(0))
        if k and k.group(1)=='campistryMe':
            leftovers.append('campistryMe STILL WRITTEN')
    if re.search(r"ARRAY\['families'", code): leftovers.append("ARRAY['families'] remains")
    if re.search(r"(?<!camp_families_object\()\w+\s*->\s*'families'", code):
        leftovers.append("->'families' remains")
    report[fn]={'file':f,'camp':camp,'applied':applied,'leftovers':leftovers,
                'orig':orig,'new':body}

json.dump({k:{'file':v['file'],'camp':v['camp'],'applied':v['applied'],
              'leftovers':v['leftovers'],'orig':v['orig'],'new':v['new']}
           for k,v in report.items()}, open('/tmp/claude-0/xform.json','w'))
print(f"{'function':<40}{'camp':<14}{'rules':<38}leftovers")
for fn,v in report.items():
    print(f"{fn:<40}{str(v['camp']):<14}{','.join(r.split()[0] for r in v['applied']):<38}"
          f"{'; '.join(v['leftovers']) if v['leftovers'] else 'clean'}")
