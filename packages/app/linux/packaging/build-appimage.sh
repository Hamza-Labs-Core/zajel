#!/bin/bash
set -euo pipefail

# Build a Zajel AppImage from the Flutter linux release bundle.
#
# Usage: ./build-appimage.sh <bundle-dir> <output-path>
#   bundle-dir: path to build/linux/x64/release/bundle
#   output-path: path for the output .AppImage file
#
# Requires: file, fuse (for appimagetool)

BUNDLE_DIR="${1:?Usage: build-appimage.sh <bundle-dir> <output-path>}"
OUTPUT_PATH="${2:?Usage: build-appimage.sh <bundle-dir> <output-path>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINUX_DIR="$(dirname "$SCRIPT_DIR")"

APPDIR="$(mktemp -d)/AppDir"
mkdir -p "$APPDIR/usr/bin" \
         "$APPDIR/usr/lib/zajel" \
         "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/256x256/apps" \
         "$APPDIR/usr/share/metainfo"

# Copy Flutter bundle contents
cp -r "$BUNDLE_DIR"/* "$APPDIR/usr/lib/zajel/"

# Create wrapper script as the binary entry point
cat > "$APPDIR/usr/bin/zajel" << 'WRAPPER'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/../lib/zajel/zajel" "$@"
WRAPPER
chmod +x "$APPDIR/usr/bin/zajel"

# Desktop file (must be at root of AppDir for appimagetool)
cp "$LINUX_DIR/com.zajel.zajel.desktop" "$APPDIR/com.zajel.zajel.desktop"
cp "$LINUX_DIR/com.zajel.zajel.desktop" "$APPDIR/usr/share/applications/"

# Icon (root of AppDir + hicolor theme)
cp "$BUNDLE_DIR/data/app_icon.png" "$APPDIR/com.zajel.zajel.png"
cp "$BUNDLE_DIR/data/app_icon.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/com.zajel.zajel.png"

# AppStream metadata
cp "$LINUX_DIR/com.zajel.zajel.appdata.xml" "$APPDIR/usr/share/metainfo/"

# AppRun entry point
cat > "$APPDIR/AppRun" << 'APPRUN'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
export PATH="$HERE/usr/bin:$PATH"
export LD_LIBRARY_PATH="$HERE/usr/lib/zajel/lib:$LD_LIBRARY_PATH"
exec "$HERE/usr/lib/zajel/zajel" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# Download appimagetool if not available
APPIMAGETOOL="$(command -v appimagetool 2>/dev/null || true)"
if [ -z "$APPIMAGETOOL" ]; then
  APPIMAGETOOL="/tmp/appimagetool"
  if [ ! -f "$APPIMAGETOOL" ]; then
    echo "Downloading appimagetool..."
    curl -fsSL -o "$APPIMAGETOOL" \
      "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x "$APPIMAGETOOL"
    # Verify the download is a valid ELF executable (basic supply-chain check)
    if ! file "$APPIMAGETOOL" | grep -q "ELF.*executable"; then
      echo "ERROR: Downloaded appimagetool is not a valid ELF executable"
      rm -f "$APPIMAGETOOL"
      exit 1
    fi
  fi
fi

# Build the AppImage
# APPIMAGE_EXTRACT_AND_RUN is required in environments without FUSE (e.g., CI runners)
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" "$APPDIR" "$OUTPUT_PATH"

echo "AppImage created: $OUTPUT_PATH"
