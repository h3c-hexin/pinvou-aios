#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"

cargo build --manifest-path "${project_dir}/Cargo.toml" --release -p pinvou-aiosd
install -d "${unit_dir}"
install -m 0644 "${project_dir}/packaging/pinvou-aiosd.service" "${unit_dir}/pinvou-aiosd.service"
systemctl --user daemon-reload
systemctl --user enable --now pinvou-aiosd.service
systemctl --user --no-pager status pinvou-aiosd.service

