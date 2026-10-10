#!/bin/sh
# Install the repoagents binary (no Bun needed): curl -fsSL https://raw.githubusercontent.com/grmkris/repoagents/main/install.sh | sh
set -eu
VERSION="${REPOAGENTS_VERSION:-latest}"
DEST="${REPOAGENTS_DIR:-$HOME/.local/bin}"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported arch: $arch" >&2; exit 1 ;; esac
case "$os" in linux|darwin) ;; *) echo "unsupported OS: $os (use the Windows .exe from the release page)" >&2; exit 1 ;; esac
suffix=""
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then suffix="-musl"; fi
name="repoagents-$os-$arch$suffix"
if [ "$VERSION" = latest ]; then base="https://github.com/grmkris/repoagents/releases/latest/download"
else base="https://github.com/grmkris/repoagents/releases/download/$VERSION"; fi
tmp=$(mktemp -d)
curl -fsSL "$base/$name" -o "$tmp/$name"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && grep " $name\$" SHA256SUMS | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -))
mkdir -p "$DEST"
install -m 0755 "$tmp/$name" "$DEST/repoagents"
rm -rf "$tmp"
echo "installed repoagents to $DEST/repoagents"
