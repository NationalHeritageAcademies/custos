// macOS notarization hook (runs via electron-builder `afterSign`).
//
// Mirrors NHA's Envy: no-op unless CUSTOS_NOTARIZE=1, so a bare `npm run dist`
// stays fast locally and doesn't fail without credentials. The release workflow
// (and `npm run package:dist`) set CUSTOS_NOTARIZE=1, so release builds are
// always notarized.
//
// Credentials come from one of two places:
//   - CI: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env vars
//     (GitHub Actions secrets — see .github/workflows/release.yml).
//   - Local: the `custos-notarize` keychain profile, created once with:
//       xcrun notarytool store-credentials custos-notarize \
//         --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-pw>
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin' || process.env.CUSTOS_NOTARIZE !== '1') return;

  const { notarize } = require('@electron/notarize');
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  const useEnv = APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID;
  const credentials = useEnv
    ? { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID }
    : { keychainProfile: 'custos-notarize' };

  console.log(`  • notarizing ${appPath} credentials=${useEnv ? 'env' : 'keychainProfile:custos-notarize'}`);
  await notarize({ appPath, ...credentials });
  console.log('  • notarized');
};
