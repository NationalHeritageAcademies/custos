# Packaging & code signing

Custos packages with **electron-builder**, following NHA's **Envy** app so it
drops into the same release process. Config: [`electron-builder.yml`](../electron-builder.yml).

- **macOS** — Developer ID signing + notarization via the `afterSign` hook
  ([`scripts/notarize.cjs`](../scripts/notarize.cjs)); universal (x64 + arm64) dmg/zip.
- **Windows** — Authenticode via **Azure Trusted Signing** using `jsign`
  ([`scripts/sign-windows.cjs`](../scripts/sign-windows.cjs)) — cross-signed from
  the macOS runner, no Windows VM.
- **Linux** — AppImage (x64 + arm64).
- **Publish** — GitHub Releases on this repo (electron-updater feed).

## Local builds

```bash
npm run dist            # unsigned local build (fast; no notarize/win-sign)
npm run dist:mac        # macOS only
npm run dist:win:test   # Windows installer, signing skipped (SKIP_WIN_SIGN=1)
npm run package:dist    # SIGNED mac + win + linux (needs creds below)
```

For local signed builds, copy `.env.example` → `.env.local` and fill it in
(notarization can instead use a keychain profile named `custos-notarize`; see
`scripts/notarize.cjs`). `brew install jsign` is required for Windows signing.

## Release (CI)

Push a `vX.Y.Z` tag (matching `package.json`'s version). The
[`release.yml`](../.github/workflows/release.yml) workflow builds, signs,
notarizes, and publishes to a GitHub Release from a single `macos-latest`
runner. Keep it **disabled until every secret exists** — a stray tag would
publish unsigned builds.

### Required repository secrets

| Secret | What |
| --- | --- |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Developer ID Application `.p12` (base64) + password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarization creds |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | service principal with the *Artifact Signing Certificate Profile Signer* role |
| `TRUSTED_SIGNING_ENDPOINT` / `TRUSTED_SIGNING_ACCOUNT` / `TRUSTED_SIGNING_PROFILE` | Azure Trusted Signing account/profile |

These are the **same secret names Envy uses**, so the values can be reused
(the Apple Developer team and the Azure Trusted Signing account are shared).

## To confirm / finish before the first release

1. **Reconcile with Envy** — `appId` (`com.nhaschools.custos`), the shared Apple
   team + Azure Trusted Signing account, and the `TRUSTED_SIGNING_ENDPOINT`
   region. Everything here was modeled on `NationalHeritageAcademies/envy`.
2. **App icon** — `build/icon.svg` is the source (the guardian mark). Generate
   `build/icon.png` (1024×1024) from it; electron-builder derives `.icns`/`.ico`.
3. **Packaging file-set** — Custos is an npm-workspace monorepo (not
   electron-vite like Envy), so on the first `npm run dist` confirm the produced
   app includes the `@custos/*` packages and the `mysql2`/`mssql` runtime deps.
   Adjust the `files` globs in `electron-builder.yml` if anything is missing.
4. **Set the repo** in `electron-builder.yml` `publish.repo` and `release.yml`
   if the repo name isn't `custos`.

Web mode (`npm run web`) needs none of this — it's the recommended path on
managed machines where an unsigned desktop binary is blocked.
