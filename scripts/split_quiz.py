#!/usr/bin/env python3
"""
Randomly select N questions from quiz.txt, move them to practice.txt,
and remove them from quiz.txt.

Usage:
    python split_quiz.py [--folder PATH] [--n 100] [--seed 42]

Assumes quiz.txt and practice.txt live in the same folder (default: current
directory). Questions in quiz.txt are separated by one or more blank lines,
e.g.:

    Which Shakespearean play is set largely in Egypt and Rome?
    A) Antony and Cleopatra
    B) Taming of the Shrew
    C) Troilus and Cressida
    D) Cymbeline
    Correct: A

    What is the capital of France?
    A) Berlin
    ...
"""

import argparse
import random
import re
from pathlib import Path


def parse_questions(text: str):
    """Split raw file text into a list of question blocks (as strings),
    preserving each block's original formatting exactly."""
    # Normalize line endings
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Split on 2+ consecutive newlines (blank line separators)
    blocks = re.split(r"\n\s*\n", text.strip())
    # Drop any accidental empty blocks
    blocks = [b.strip("\n") for b in blocks if b.strip()]
    return blocks


def main():
    parser = argparse.ArgumentParser(description="Randomly move N questions from quiz.txt to practice.txt")
    parser.add_argument("--folder", type=str, default=".", help="Folder containing quiz.txt and practice.txt")
    parser.add_argument("--n", type=int, default=100, help="Number of questions to move")
    parser.add_argument("--seed", type=int, default=None, help="Optional random seed for reproducibility")
    args = parser.parse_args()

    folder = Path(args.folder)
    quiz_path = folder / "quiz.txt"
    practice_path = folder / "practice.txt"

    if not quiz_path.exists():
        raise SystemExit(f"Could not find {quiz_path}")

    if args.seed is not None:
        random.seed(args.seed)

    original_text = quiz_path.read_text(encoding="utf-8")
    questions = parse_questions(original_text)

    total = len(questions)
    if total == 0:
        raise SystemExit("No questions found in quiz.txt (check formatting/blank-line separators).")

    n = min(args.n, total)
    if n < args.n:
        print(f"Warning: only {total} questions available, selecting all {n}.")

    # Randomly choose indices to move
    selected_indices = set(random.sample(range(total), n))

    selected_questions = [questions[i] for i in sorted(selected_indices)]
    # Shuffle the order they appear in practice.txt too, so it's not just quiz order
    random.shuffle(selected_questions)

    remaining_questions = [q for i, q in enumerate(questions) if i not in selected_indices]

    # Append to practice.txt if it already has content, otherwise create it
    practice_existing = ""
    if practice_path.exists():
        practice_existing = practice_path.read_text(encoding="utf-8").strip()

    practice_blocks = ([practice_existing] if practice_existing else []) + selected_questions
    practice_text = "\n\n".join(practice_blocks) + "\n"

    remaining_text = "\n\n".join(remaining_questions) + "\n" if remaining_questions else ""

    practice_path.write_text(practice_text, encoding="utf-8")
    quiz_path.write_text(remaining_text, encoding="utf-8")

    print(f"Moved {n} questions from quiz.txt to practice.txt.")
    print(f"quiz.txt now has {len(remaining_questions)} questions remaining.")
    print(f"practice.txt now has {len(practice_blocks)} questions total.")


if __name__ == "__main__":
    main()