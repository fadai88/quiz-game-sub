#!/usr/bin/env python3
"""
Convert a quiz SQLite database (questions/answers tables) to a JSON file that
scripts/import-questions.js can load into MongoDB.

Why: the Node `sqlite3` native module is platform/ABI-specific and breaks when
node_modules is shared between Windows and WSL, or on very new Node versions.
Python's sqlite3 is part of the standard library and works everywhere, so we use
it to read the .db and hand a plain JSON file to the Mongo importer.

Usage:
    python scripts/db_to_json.py data/practice.db data/practice.json
    python scripts/db_to_json.py data/quiz.db     data/quiz.json
"""
import sqlite3
import json
import sys
import os


def main():
    if len(sys.argv) < 3:
        print("Usage: python scripts/db_to_json.py <input.db> <output.json>")
        sys.exit(1)

    db_path, out_path = sys.argv[1], sys.argv[2]
    if not os.path.exists(db_path):
        print(f"ERROR: {db_path} not found")
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # One row per question, with its answers concatenated in answer_id order.
    rows = cur.execute(
        """
        SELECT q.question_id,
               q.question,
               GROUP_CONCAT(a.answer, '|||'),
               GROUP_CONCAT(a.is_correct, '|||')
        FROM questions q
        JOIN answers a ON q.question_id = a.question_id
        GROUP BY q.question_id
        ORDER BY q.question_id
        """
    ).fetchall()

    out, skipped = [], 0
    for qid, question, answers_str, correct_str in rows:
        answers = (answers_str or "").split("|||")
        is_correct = [int(x) for x in (correct_str or "").split("|||") if x != ""]

        if 1 not in is_correct:
            print(f"skip (no correct answer): {str(question)[:50]}")
            skipped += 1
            continue
        if len(answers) < 2:
            print(f"skip (not enough options): {str(question)[:50]}")
            skipped += 1
            continue

        out.append(
            {
                "question": question,
                "options": answers,
                "correctAnswer": is_correct.index(1),
            }
        )

    conn.close()

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f"Wrote {len(out)} questions to {out_path} (skipped {skipped})")


if __name__ == "__main__":
    main()
