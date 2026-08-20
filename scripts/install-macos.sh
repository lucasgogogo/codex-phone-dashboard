#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(dirname -- "$script_dir")"
node_path="$(command -v node)"
major="$($node_path --version | sed -E 's/^v([0-9]+).*/\1/')"
[ "$major" -ge 20 ] || { printf 'Node.js 20 or newer is required.\n' >&2; exit 1; }

cd "$project_root"
npm install
npm test
"$script_dir/configure-startup-macos.sh" install
