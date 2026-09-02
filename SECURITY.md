# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub's **[Report a vulnerability](https://github.com/NationalHeritageAcademies/custos/security/advisories/new)**
(the *Security* tab → *Advisories*). We aim to acknowledge reports within a few
business days and will coordinate a fix and disclosure with you.

When reporting, please include:

- affected version / commit,
- steps to reproduce or a proof of concept,
- the impact you observed.

## Scope & handling of sensitive data

Custos connects to databases and handles credentials, so a few design notes:

- **Credentials** are stored in the OS keychain via Electron `safeStorage` on the
  desktop app, and **in memory only** in the local web host (`npm run web`). They
  are never written to disk in plaintext. Non-secret connection metadata is stored
  under the user-data directory (`~/.custos` for the web host).
- **No telemetry.** Custos makes no outbound network calls except to the databases
  you configure. Fonts are bundled locally. Choosing a Microsoft Entra
  authentication mode adds calls to Microsoft's own sign-in endpoints
  (`login.microsoftonline.com`, and `microsoft.com/devicelogin` for a device code),
  and nothing else.
- **Entra sign-ins are never persisted.** For the Entra auth modes Custos stores no
  secret at all: the token session (an `@azure/identity` credential and its MSAL
  cache) lives in the main process's memory, keyed by tenant + app registration, and
  dies with the process. Custos never handles the password or the MFA challenge — it
  relays the device code Microsoft issued. The only URL it will hand to your browser
  is the provider's own sign-in page, checked against a host allowlist.
- The **web host binds to `127.0.0.1` only.** It is a local tool; do not expose it
  to a network without adding authentication and encrypted-at-rest secret storage.
- Guardrails against accidental data loss (per-connection read-only mode,
  confirm-before-unbounded-write) are conveniences, **not** a security boundary —
  they run client-side/in the app process.

## Supported versions

Custos is pre-1.0; only the latest release is supported. Please upgrade before
reporting an issue.
