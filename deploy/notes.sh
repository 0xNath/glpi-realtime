#!/usr/bin/env bash
# Upgrade notes: the "Configuration:" paragraphs of CHANGELOG.md for the versions after
# FROM up to TO (and "Unreleased" when installing from the repository), oldest first.
# These are what users edit themselves after upgrading.
#   deploy/notes.sh FROM TO [CHANGELOG.md]
set -euo pipefail
from=$1 to=$2
log=${3:-"$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md"}
[[ -f "$log" ]] || exit 0
# newer A B: A > B (versions, "Unreleased" being the newest).
newer() {
    [[ "$1" == Unreleased ]] && return 0
    [[ "$2" == Unreleased || "$1" == "$2" ]] && return 1
    [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]
}
awk '
    /^## / { version = $2; next }
    /^Configuration:/ { inpara = 1 }
    inpara && /^$/ { inpara = 0; print ""; next }
    inpara { print version "\t" $0 }
' "$log" | {
    declare -A paras
    order=()
    while IFS=$'\t' read -r version line; do
        [[ -z "$version" ]] && continue
        if newer "$version" "$from" && ! newer "$version" "$to" || { [[ "$version" == Unreleased ]] && newer "$version" "$from"; }; then
            [[ -v "paras[$version]" ]] || order+=("$version")
            paras[$version]+="$line"$'\n'
        fi
    done
    # The changelog lists the newest first: print the oldest first.
    for ((i = ${#order[@]} - 1; i >= 0; i--)); do
        v=${order[i]}
        printf '%s — %s' "$v" "${paras[$v]}"
    done
}
