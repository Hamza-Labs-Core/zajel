#!/bin/bash
set -euo pipefail

# Build a Zajel .deb package from the Flutter linux release bundle.
#
# Usage: ./build-deb.sh <bundle-dir> <version> <output-path>
#   bundle-dir: path to build/linux/x64/release/bundle
#   version: package version (e.g., 1.5.3)
#   output-path: path for the output .deb file

BUNDLE_DIR="${1:?Usage: build-deb.sh <bundle-dir> <version> <output-path>}"
VERSION="${2:?Usage: build-deb.sh <bundle-dir> <version> <output-path>}"
OUTPUT_PATH="${3:?Usage: build-deb.sh <bundle-dir> <version> <output-path>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINUX_DIR="$(dirname "$SCRIPT_DIR")"

PKGDIR="$(mktemp -d)/zajel_${VERSION}_amd64"

# Create directory structure
mkdir -p "$PKGDIR/DEBIAN" \
         "$PKGDIR/usr/lib/zajel" \
         "$PKGDIR/usr/bin" \
         "$PKGDIR/usr/share/applications" \
         "$PKGDIR/usr/share/icons/hicolor/256x256/apps" \
         "$PKGDIR/usr/share/metainfo"

# Control file
cat > "$PKGDIR/DEBIAN/control" << EOF
Package: zajel
Version: ${VERSION}
Section: net
Priority: optional
Architecture: amd64
Depends: libgtk-3-0, libsecret-1-0, libglib2.0-0, libstdc++6, libc6
Maintainer: Zajel <support@zajel.app>
Homepage: https://zajel.app
Description: Private peer-to-peer encrypted messaging
 Zajel enables secure, private messaging between devices using
 end-to-end encryption with X25519 key exchange and ChaCha20-Poly1305.
 Features include direct P2P connections, encrypted file transfer,
 channels, groups, and voice/video calls.
EOF

# Copy Flutter bundle
cp -r "$BUNDLE_DIR"/* "$PKGDIR/usr/lib/zajel/"

# Create symlink for PATH access
ln -sf /usr/lib/zajel/zajel "$PKGDIR/usr/bin/zajel"

# Desktop file (fix Exec path for system install)
sed 's|^Exec=zajel|Exec=/usr/bin/zajel|' \
  "$LINUX_DIR/com.zajel.zajel.desktop" \
  > "$PKGDIR/usr/share/applications/com.zajel.zajel.desktop"

# Icon
cp "$BUNDLE_DIR/data/app_icon.png" \
  "$PKGDIR/usr/share/icons/hicolor/256x256/apps/com.zajel.zajel.png"

# AppStream metadata
cp "$LINUX_DIR/com.zajel.zajel.appdata.xml" \
  "$PKGDIR/usr/share/metainfo/"

# Calculate installed size (in KB)
INSTALLED_SIZE=$(du -sk "$PKGDIR" | cut -f1)
echo "Installed-Size: ${INSTALLED_SIZE}" >> "$PKGDIR/DEBIAN/control"

# Build the package
dpkg-deb --build --root-owner-group "$PKGDIR" "$OUTPUT_PATH"

echo "Debian package created: $OUTPUT_PATH"
