#!/usr/bin/env python3
"""
Remove from quiz.db every question that also exists in practice.db, so the two
banks never overlap.

IMPORTANT: matches on the FULL question — text AND options AND correct answer —
NOT text alone. Many questions share the same text but have different options;
those are DIFFERENT questions and are kept in quiz.db. Only a question that is
byte-for-byte the same (ignoring option ORDER, since the game shuffles options)
as a practice question is removed.

Typical workflow after editing quiz.txt:
    python scripts/quiz_db.py quiz.txt data/quiz.db     # rebuild (may re-add practice Qs)
    python scripts/separate_practice.py                 # strip practice overlap back out
    python scripts/db_to_json.py data/quiz.db data/quiz.json
    node   scripts/import-questions.js data/quiz.json quiz

Usage:
    python scripts/separate_practice.py [quiz.db] [practice.db]
    # defaults: data/quiz.db  data/practice.db
"""
import sqlite3
import re
import sys
import os


def strip_prefix(opt):
    return re.sub(r"^\s*[A-Za-z]\)\s*", "", opt or "").strip()


def signatures(db):
    """question_id -> (text, frozenset(option texts), correct answer text)."""
    conn = sqlite3.connect(db)
    out = {}
    for qid, q in conn.execute("select question_id, question from questions"):
        ans = conn.execute(
            "select answer, is_correct from answers where question_id=? order by answer_id",
            (qid,),
        ).fetchall()
        out[qid] = (
            q.strip(),
            frozenset(strip_prefix(a) for a, _ in ans),
            strip_prefix(next((a for a, ic in ans if ic == 1), None)),
        )
    conn.close()
    return out


def main():
    quiz_db = sys.argv[1] if len(sys.argv) > 1 else "data/quiz.db"
    practice_db = sys.argv[2] if len(sys.argv) > 2 else "data/practice.db"
    for p in (quiz_db, practice_db):
        if not os.path.exists(p):
            print(f"ERROR: {p} not found")
            sys.exit(1)

    practice_sigs = set(signatures(practice_db).values())
    quiz_rows = signatures(quiz_db)
    to_delete = [qid for qid, sig in quiz_rows.items() if sig in practice_sigs]

    print(f"quiz.db:     {len(quiz_rows)} questions")
    print(f"practice.db: {len(practice_sigs)} unique questions")
    print(f"exact matches to remove from quiz.db: {len(to_delete)}")

    if not to_delete:
        print("Nothing to remove — quiz.db already has no practice overlap.")
        return

    conn = sqlite3.connect(quiz_db)
    cur = conn.cursor()
    cur.executemany("delete from answers where question_id=?", [(q,) for q in to_delete])
    cur.executemany("delete from questions where question_id=?", [(q,) for q in to_delete])
    conn.commit()
    remaining = cur.execute("select count(*) from questions").fetchone()[0]
    conn.execute("VACUUM")
    conn.close()
    print(f"Removed {len(to_delete)}. quiz.db now has {remaining} questions, no practice overlap.")


if __name__ == "__main__":
    main()
