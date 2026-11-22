#!/bin/sh
set -eu

version=${1:-latest}
case "$version" in
  latest) base=https://github.com/yihui/luochu/releases/latest/download ;;
  v[0-9]*)
    case "$version" in *[!A-Za-z0-9._-]*) echo "Invalid version: $version" >&2; exit 1 ;; esac
    base="https://github.com/yihui/luochu/releases/download/$version"
    ;;
  *) echo "Use a version tag such as v0.1.0-alpha.1, or omit it for the latest stable release." >&2; exit 1 ;;
esac

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported operating system." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture." >&2; exit 1 ;;
esac

archive="luochu-$os-$arch.tar.gz"
tmp=$(mktemp -d)
cleanup() {
  rm -f "$tmp/$archive" "$tmp/SHA256SUMS" "$tmp/luochu"
  rmdir "$tmp"
}
trap cleanup EXIT

curl -fsSL "$base/$archive" -o "$tmp/$archive"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
expected=$(awk -v name="./$archive" '$2 == name { print $1 }' "$tmp/SHA256SUMS")
if ! printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "Missing or invalid checksum for $archive." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
else
  echo "sha256sum or shasum is required." >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "Checksum verification failed for $archive." >&2
  exit 1
fi

tar -xzf "$tmp/$archive" -C "$tmp" luochu
destination=${LUOCHU_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$destination"
install -m 755 "$tmp/luochu" "$destination/luochu"
printf 'Installed %s/luochu\n' "$destination"
