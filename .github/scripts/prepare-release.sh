#!/usr/bin/env bash

# exit upon failure
set -e

# setup
[[ -n "${DEBUG_SCRIPT}" ]] && set -xv

# shell swag
RED="\033[1;91m"
CYAN="\033[1;36m"
GREEN="\033[1;32m"
WHITE="\033[1;38;5;231m"
RESET="\n\033[0m"

# logging
log_std() { echo -e "${CYAN}==> ${WHITE}${1}${RESET}"; }
log_err() { echo -e "${RED}==> ${WHITE}${1}${RESET}"; }

# vars
version=${TAG_REF/refs\/tags\//}
log_std "Preparing release ${GREEN}${version}"

# create release directory
mkdir release

# artifacts files
cd artifacts
for file in */*
do
  cp "${file}" "../release/$(dirname "${file}")-${version}"
done

# release files
cd ../release
for file in *
do
  sha256sum "${file}" > "${file}.sha256sum"
done

tar czf "all-files-${version}.tar.gz" *
sha256sum "all-files-${version}.tar.gz" > "all-files-${version}.tar.gz.sha256sum"
all_files_sha="$( cat "all-files-${version}.tar.gz.sha256sum" | cut -f 1 -d ' ' )"

# release body
cat <<EOF > "../${RELEASE_BODY_FILE}"
## SHA 256
EOF

echo "## SHA 256" > "../${RELEASE_BODY_FILE}"
for file in *.sha256sum
do
  echo "- \`$( cat "${file}" | cut -f 1 -d ' ' )\` ${file}" >> "../${RELEASE_BODY_FILE}"
done

cat <<EOF >> "../${RELEASE_BODY_FILE}"

## Change log
EOF
echo "${CHANGE_LOG}" >> "../${RELEASE_BODY_FILE}"

# github output
for output in "new_version=${version}" "all_files_sha=${all_files_sha}"
do
  echo "${output}" >> "$GITHUB_OUTPUT"
done
