# Security

## Scope and Trust

This is a LAN queue-sharing extension, not an audio streaming service. It is
not independently security-audited. Use trusted private networks and keep Node,
Java and Chrome updated. Network isolation and firewall rules remain important:
bounded resources reduce denial-of-service exposure but cannot eliminate it.

The browser extension is restricted to music.youtube.com and native messaging.
It has no remote scripts, externally connectable API, persistent invitation
storage, or public HTTP control port. Chrome allows only the fixed extension
origin to connect to the registered helper. The public manifest key stabilizes
that origin; it is not a signing credential or proof of publisher identity.

YouTube Music's page and its internal queue APIs are necessarily trusted to
perform player actions. A closed shadow root is UI encapsulation, not a security
boundary. The helper and browser run with the current user's privileges; an
attacker who can modify local installation files already has that user's access.

## Network Defenses

- Invitation secrets are random 256-bit values. Mutual HMAC authentication,
  directional AES-GCM keys and monotonic record sequences match Android.
- Short codes use Android's actual Bouncy Castle J-PAKE implementation, expire
  after ten minutes, and allow two concurrent handshakes, eight attempts per
  minute and 32 attempts total per code. Discovery is unauthenticated; the
  subsequent PAKE and encrypted invitation exchange authenticate the connection.
- The main listener accepts private LAN addresses, with eight active sockets.
  Pairing also permits loopback for local interoperability tests. Discovery
  replies and endpoint hints are limited to private/link-local addresses.
- Frames, buffered bytes, native requests, pending edits, session identities,
  command-result caches and queue lengths have limits. Slow handshakes time out.
- Host snapshots are validated and reduced to expected fields before Chrome
  receives them. Thumbnail URLs are reconstructed from validated video IDs.
- Leave/end cancels handshakes and clears key buffers. JavaScript strings,
  clipboard contents and garbage-collected copies cannot be reliably erased.
  Anyone with a full invitation can join until the Jam expires or ends; rotating
  the short code does not revoke previously issued full invitations.

## Installation Trust

The bootstrap downloads a fixed GitHub release and verifies its embedded SHA-256
before extracting or executing it. Archive paths, symlinks and expansion size
are checked. Dependencies are included in the release; source installs use a
lockfile and disable npm lifecycle scripts. Java dependency downloads use pinned
checksums. The installer uses HKCU, does not disable Chrome security or install
enterprise policies, and clears runtime injection environment variables in the
launcher. Prerequisites may be installed via winget with normal Windows approval.

The bootstrap itself is executable code fetched from GitHub. HTTPS and a checksum
do not protect against a compromised GitHub account replacing both installer and
release. Review the script, or use an immutable commit URL and independently
verify its hash. Releases are not Authenticode-signed. Close Jams before updating;
the installer keeps a backup and restores registration/files if installation fails.

## Reporting

Use the repository's private vulnerability reporting page, when enabled:
https://github.com/JamQueueSharing/jam-chrome/security/advisories/new
Do not post invitation links, secrets, pairing codes or personal browser profiles
in public issues. Report reproducible steps and affected release versions.
