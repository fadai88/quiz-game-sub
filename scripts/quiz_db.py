#!/usr/bin/env python3
"""
Build a quiz SQLite database from a plain-text question file.

Input format — one block per question, blank lines between blocks are fine:

    Some question text ending in a question mark?
    A) first option
    B) second option
    C) third option
    D) fourth option
    Correct: B

Usage:
    python scripts/quiz_db.py <input.txt> <output.db>
    python scripts/quiz_db.py                       # defaults: quiz.txt -> quiz.db

    # Recommended — write straight into data/ so the next step finds it:
    python scripts/quiz_db.py quiz.txt data/quiz.db

Robustness (vs. the original):
  - A malformed question is REPORTED and SKIPPED; parsing continues. The old
    version stopped silently at the first bad block and dropped every question
    after it, with no error.
  - No unused imports (the old `import pandas` crashed the script when pandas
    wasn't installed).
  - The output DB is overwritten cleanly, so re-runs never append duplicates.

Output schema (unchanged, so db_to_json.py stays compatible):
    questions(question_id INTEGER PRIMARY KEY, question TEXT)
    answers(answer_id INTEGER PRIMARY KEY, question_id INTEGER, answer TEXT, is_correct BOOLEAN)
  Answers keep the "A) ..." prefix to match the existing data and game display.
"""
import re
import sqlite3
import sys
import os

# A question block is everything up to a line that starts with "Correct: <letter>".
# "Correct:" must be at the start of a line so the word appearing inside a
# question or option can't end a block early.
BLOCK_RE = re.compile(
    r"(?P<body>.*?)^[ \t]*Correct:[ \t]*(?P<letter>[A-Za-z])\b",
    re.DOTALL | re.MULTILINE,
)
# First "A)" option marker (line start) — marks where the question ends.
FIRST_A_RE = re.compile(r"^[ \t]*A\)", re.MULTILINE)
# Each option: a letter marker at line start, text up to the next marker or end.
OPTION_RE = re.compile(
    r"^[ \t]*([A-D])\)[ \t]*(.*?)\s*(?=^[ \t]*[A-D]\)|\Z)",
    re.DOTALL | re.MULTILINE,
)


def snippet(text, n=60):
    s = " ".join(str(text).split())
    return (s[:n] + "…") if len(s) > n else s


def parse(content):
    """Return (questions, errors). Never raises on a bad block — records it."""
    questions, errors = [], []
    qnum = 0
    for m in BLOCK_RE.finditer(content):
        qnum += 1
        body = m.group("body")
        letter = m.group("letter").upper()

        a = FIRST_A_RE.search(body)
        if not a:
            errors.append((qnum, "no 'A)' option marker found", snippet(body)))
            continue

        question = body[: a.start()].strip()
        options = {
            om.group(1): om.group(2).strip()
            for om in OPTION_RE.finditer(body[a.start():])
        }

        problems = []
        if not question:
            problems.append("empty question")
        for letter_key in "ABCD":
            if not options.get(letter_key):
                problems.append(f"missing option {letter_key}")
        if letter not in "ABCD":
            problems.append(f"invalid correct letter '{letter}'")

        if problems:
            errors.append((qnum, "; ".join(problems), snippet(question or body)))
            continue

        questions.append(
            {
                "question": question,
                # keep the "A) ..." prefix to match the existing DB / game display
                "answers": [f"{L}) {options[L]}" for L in "ABCD"],
                "correct_index": "ABCD".index(letter),
            }
        )
    return questions, errors


def write_db(questions, db_path):
    # Overwrite cleanly so re-runs don't append duplicates.
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path, timeout=5)
    cur = conn.cursor()
    cur.execute(
        "CREATE TABLE questions (question_id INTEGER PRIMARY KEY, question TEXT)"
    )
    cur.execute(
        "CREATE TABLE answers ("
        "answer_id INTEGER PRIMARY KEY, question_id INTEGER, answer TEXT, "
        "is_correct BOOLEAN, FOREIGN KEY(question_id) REFERENCES questions(question_id))"
    )

    answer_id = 0
    for qid, q in enumerate(questions):
        cur.execute(
            "INSERT INTO questions (question_id, question) VALUES (?, ?)",
            (qid, q["question"]),
        )
        for j, ans in enumerate(q["answers"]):
            cur.execute(
                "INSERT INTO answers (answer_id, question_id, answer, is_correct) "
                "VALUES (?, ?, ?, ?)",
                (answer_id, qid, ans, 1 if j == q["correct_index"] else 0),
            )
            answer_id += 1

    conn.commit()
    conn.close()


def main():
    in_path = sys.argv[1] if len(sys.argv) > 1 else "quiz.txt"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "quiz.db"

    if not os.path.exists(in_path):
        print(f"ERROR: input file not found: {in_path}")
        sys.exit(1)

    with open(in_path, encoding="utf-8") as f:
        content = f.read()

    questions, errors = parse(content)

    for qnum, reason, where in errors:
        print(f"⚠️  Skipped question #{qnum}: {reason}  ->  {where}")

    if not questions:
        print("ERROR: no valid questions parsed — nothing written.")
        sys.exit(1)

    write_db(questions, out_path)

    summary = f"✅ Wrote {len(questions)} questions to {out_path}"
    if errors:
        summary += f"  ({len(errors)} skipped — see warnings above)"
    print(summary)


if __name__ == "__main__":
    main()
