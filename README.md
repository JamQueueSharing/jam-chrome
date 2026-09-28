# Morphe Jam for Chrome

Host and join Morphe Jam sessions on **https://music.youtube.com/** using the Android project's encrypted LAN protocol.

## Install on Windows

Run in PowerShell (close active Jams before installing or updating):

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/JamQueueSharing/jam-chrome/v0.2.0/install.ps1').Content))
```

The script downloads release 0.2.0, verifies a pinned SHA-256, installs missing Node.js/Java through winget, and registers the native helper for your Windows user. Runtime dependencies and browser assets are included. Node.js 22+ and Java 17+ are required; an outdated existing runtime must be upgraded manually. Review [install.ps1](install.ps1) before running downloaded code. See [SECURITY.md](SECURITY.md) for the trust model and limitations.

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select `%LOCALAPPDATA%\JamQueueSharing\JamChrome\current\extension` (the installer prints the full path).
3. Reload YouTube Music. Open a song and **Up next**, then click the embedded **Jam** button. The Chrome toolbar button also opens the session panel.

Chrome requires this one-time Load unpacked step for GitHub-distributed extensions on ordinary Windows installations. The command cannot silently install it without Web Store distribution or enterprise management, and it does not alter those policies. The stable extension ID is `pbelfbgngnnclggehcpnhdkimaikonpm`. Existing pre-0.2 development installations must be removed and loaded again because their ID was path-dependent. No ID copying is needed. The helper starts automatically when used.

For updates, run the new release's command, then click Reload in Chrome and refresh YouTube Music. The installer retains backup folders and restores the previous installation/registration if registration fails. To remove registration, run `& "$env:LOCALAPPDATA\JamQueueSharing\JamChrome\current\install-windows.ps1" -Uninstall`, then remove the extension in Chrome. Files are retained for manual removal. Source checkout installation is also supported: run `./install-windows.ps1` and load that checkout's `extension` directory.

## Use

- **Host:** start a song and select Start Jam. Android can scan the displayed QR invitation or enter the eight-character code. Codes expire after ten minutes; New code replaces the code without disconnecting existing participants. Copy invitation also remains available. Both devices need a shared LAN. If Windows asks, allow Node.js on your private network.
- **Join:** enter Android's short code or full invitation, or use Scan QR (camera permission required) or Open QR image. Scanning fills the invitation field; select Join Jam to connect. Chrome pauses local audio. YouTube Music's own Up next rows show the host's queue, metadata, artwork and current selection.
- Use native queue row clicks, drag reorder, and Remove from queue. Native single-song Add to queue and Play next menu actions send commands to the host. Queue changes appear after the host acknowledges them.
- Host edits use YouTube Music's native queue store. They do not rebuild playback with `loadPlaylist`.
- Leave Jam restores the local queue view and leaves local audio paused. Guest locking, playback controls, reconnect and session expiration follow the Jam protocol.

## Current Limits

- QR invitations and Android-compatible J-PAKE short codes work over LAN. Wi-Fi Aware and BLE are not implemented in Chrome. Network client isolation or blocked multicast/broadcast can prevent code discovery; try a full QR invitation on a reachable LAN.
- Windows has an installer. Other operating systems need their own native-host registration.
- Guest main and autoplay items appear consecutively in Up next; their protocol lanes are retained for edits. Chrome hosting publishes the web player's loaded queue as the main lane and does not export a separate automix lane.
- Bulk playlist actions and shuffle are blocked while joined. Add one track at a time. Rapid edits can be rejected when their revision is stale; the authoritative queue remains visible.
- The native web integration relies on YouTube Music's internal queue store. A site update may require adapting `extension/player.js` and `extension/native-queue.js`.
- Browser tests cover the live site's queue rendering and mutations, but a physical Android-to-Chrome session and audible playback have not been verified end to end.

## Code Map

| File                             | Responsibility                                                      |
| -------------------------------- | ------------------------------------------------------------------- |
| `extension/content.js`           | Embedded session controls; no separate queue renderer               |
| `extension/background.js`        | One session tab, Chrome native messaging, page adapter calls        |
| `extension/player.js`            | Read and modify the host's native YouTube Music queue               |
| `extension/native-queue.js`      | Guest queue view, native gestures, local view restoration           |
| `native/host.mjs`                | Session lifecycle, hosting, joining, reconnect and command routing  |
| `native/queue.mjs`               | Stable IDs, revisions, guest lock and duplicate command results     |
| `native/protocol.mjs`            | Android-compatible invitations, HMAC handshake and AES-GCM records  |
| `native/network.mjs`             | LAN sockets, invitation endpoint hints and UDP discovery            |
| `native/pairing.mjs`             | Short-code discovery, limits, Java worker and authenticated handoff |
| `native/java/PairingWorker.java` | Private pipe wrapper around the actual Android CodeExchange         |

Invitations and encryption keys stay in memory and are not logged or saved. The extension only has access to music.youtube.com. The helper uses Chrome's native messaging pipe, not a public HTTP or WebSocket control port. Google credentials remain in YouTube Music; song metadata is resolved through its existing page service.

## Verification

```powershell
npm ci
npm test
npx playwright install chromium
npm run test:browser
node tests/browser-check.mjs --native
npm run test:live
```

The protocol tests compile the existing Android `SecureChannel.java` using `javac` and communicate with it in both roles. Run from this workspace with Java installed. The helper tests need a private LAN interface. Live tests use an isolated browser profile and real YouTube Music queue endpoints; they do not touch your normal Chrome profile.

Screenshots and test profiles are under ignored `test-output/`. Refresh the local Lucide and QR browser bundles with `npm run vendor`. Camera frames and imported images are decoded locally, never uploaded. Closing the panel stops the camera.

`npm run build:pairing` rebuilds the Java worker from the unchanged Android sources using JDK 17 or newer. Bouncy Castle 1.83 and org.json 20240303 are downloaded with pinned SHA-256 checksums. Pairing tests run Android's actual CodeExchange in both roles and verify the same-socket Jam handoff. The short code is authenticated with J-PAKE, not used directly as an encryption key. Hosts limit attempts to 32 per code, eight per minute and two concurrent handshakes.

References: [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Pear Desktop's native queue integration](https://github.com/pear-devs/pear-desktop/blob/master/src/renderer.ts). Queue actions were also verified against the live YouTube Music site on September 28, 2026.
