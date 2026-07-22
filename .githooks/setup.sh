#!/bin/sh
# Enable this repo's versioned git hooks. Run once per clone:
#   sh .githooks/setup.sh
git config core.hooksPath .githooks
echo "✓ git hooks enabled (core.hooksPath = .githooks)"
