#!/usr/bin/env bash
# Kept for habit: upgrading is the same as installing (deploy/install.sh), which only
# replaces the binary and the plugin files and never touches configuration.
exec "$(dirname "$0")/install.sh" "$@"
