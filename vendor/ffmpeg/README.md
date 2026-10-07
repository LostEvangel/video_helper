# Bundled FFmpeg for Video Helper

This directory supplies the two executables copied into the installer at `resources/bin`. The application bundles FFmpeg and FFprobe so its media behavior does not depend on software installed elsewhere on the user's computer.

The binaries are from the Gyan.dev FFmpeg 8.1.2 essentials Windows x64 static build. That build is licensed under GPL version 3. Its embedded build notes are in `README.txt`, and the complete GPL text is in `LICENSE`. The build notes identify the FFmpeg source commit and configure flags. The upstream FFmpeg source is available at <https://github.com/FFmpeg/FFmpeg/commit/38b88335f9>.

The downloaded source archive used to verify this package was `ffmpeg-essentials.zip`, SHA-256 `db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec`. The archive itself and `ffplay.exe` are not included in Video Helper. `source.json` records the artifact and executable hashes.
