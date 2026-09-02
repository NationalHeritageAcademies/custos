import {
  AzureCliCredential,
  DeviceCodeCredential,
  InteractiveBrowserCredential,
  type AuthenticationRecord,
  type TokenCredential,
} from '@azure/identity';
import {
  ConnectionError,
  SignInRequiredError,
  type AuthParams,
  type SignInKind,
  type SignInPrompt,
  type SignInRequirement,
} from '@custos/core';

/**
 * Microsoft Entra ID sign-in for the Azure SQL driver.
 *
 * Custos never handles the user's password for these modes: it hands tedious a
 * `TokenCredential` (`authentication.type: 'token-credential'`), and tedious
 * asks that credential for a token at every login — so tokens refresh
 * themselves as the pool opens new connections, and MFA is handled entirely by
 * Microsoft in the browser.
 *
 * Credentials are cached per (mode, tenant, client) for the life of the
 * process, so one sign-in covers every connection to that tenant, and the MSAL
 * token cache behind it can refresh silently. Nothing is written to disk: quit
 * Custos and the session is gone, which is the same promise the rest of the app
 * makes about secrets.
 */

/**
 * The scope tedious itself requests for Azure SQL (it derives
 * `new URL('/.default', spn)` from the server's federated-auth SPN, which is
 * `https://database.windows.net/` in the public cloud). Authenticating against
 * the same scope means our explicit sign-in warms the exact token tedious will
 * ask for, so connecting afterwards needs no extra round trip.
 */
const SQL_SCOPE = 'https://database.windows.net/.default';

/** Auth modes handled here, mapped to how the user completes them. */
const ENTRA_MODES: Record<string, SignInKind | null> = {
  'entra-mfa': 'device-code',
  'entra-browser': 'browser',
  'entra-azure-cli': null, // the Azure CLI already signed in (MFA included)
};

/** The interactive credentials expose `authenticate()`; AzureCliCredential does not. */
interface AuthenticatingCredential extends TokenCredential {
  authenticate(scopes: string | string[], options?: { abortSignal?: AbortSignal }):
    Promise<AuthenticationRecord | undefined>;
}

/**
 * Where a provider prompt is delivered. The credential's prompt callback is
 * fixed at construction time, but the UI listening for it changes with every
 * sign-in — so the callback writes to this indirection instead.
 */
interface PromptSink {
  current?: (prompt: SignInPrompt) => void;
}

interface CachedCredential {
  readonly key: string;
  readonly credential: TokenCredential;
  /** How the user signs in, or null when no interaction is possible/needed. */
  readonly kind: SignInKind | null;
  readonly sink: PromptSink;
  /** Account signed in during this process run, or null. */
  account: string | null;
}

const credentials = new Map<string, CachedCredential>();

/** The Entra auth mode in these params, or null when the mode is not an Entra one. */
export function entraMode(params: AuthParams): string | null {
  const mode = String(params.authMode ?? '');
  return mode in ENTRA_MODES ? mode : null;
}

/** True for the modes that need the user to complete a sign-in in a browser. */
export function isInteractiveEntraMode(params: AuthParams): boolean {
  const mode = entraMode(params);
  return !!mode && ENTRA_MODES[mode] !== null;
}

/** Cache key: one sign-in is shared by every connection to the same tenant + app. */
function cacheKey(params: AuthParams, mode: string): string {
  const tenantId = String(params.tenantId ?? '').trim();
  const clientId = String(params.clientId ?? '').trim();
  return `${mode}|${tenantId || 'organizations'}|${clientId || 'default'}`;
}

function build(mode: string, tenantId: string, clientId: string, sink: PromptSink): TokenCredential {
  // A tenant is optional: without one, Microsoft resolves the user's own.
  const common = {
    ...(tenantId ? { tenantId } : {}),
    ...(clientId ? { clientId } : {}),
    // Never prompt from inside getToken(): a connect (or a token refresh hours
    // later) has nowhere to show a device code. Sign-in is always the explicit,
    // user-visible `signIn` flow; getToken stays silent and fails loudly.
    disableAutomaticAuthentication: true,
  };
  if (ENTRA_MODES[mode] === 'device-code') {
    return new DeviceCodeCredential({
      ...common,
      userPromptCallback: (info) =>
        sink.current?.({
          kind: 'device-code',
          message: info.message,
          userCode: info.userCode,
          verificationUri: info.verificationUri,
        }),
    });
  }
  if (ENTRA_MODES[mode] === 'browser') {
    return new InteractiveBrowserCredential(common);
  }
  return new AzureCliCredential(tenantId ? { tenantId } : {});
}

/**
 * The cached credential for these params, or null when the params do not use an
 * Entra auth mode. Creating a credential performs no I/O.
 */
export function getEntraCredential(params: AuthParams): CachedCredential | null {
  const mode = entraMode(params);
  if (!mode) return null;
  const tenantId = String(params.tenantId ?? '').trim();
  const clientId = String(params.clientId ?? '').trim();
  const key = cacheKey(params, mode);
  const existing = credentials.get(key);
  if (existing) return existing;
  const sink: PromptSink = {};
  const entry: CachedCredential = {
    key,
    credential: build(mode, tenantId, clientId, sink),
    kind: ENTRA_MODES[mode] ?? null,
    sink,
    account: null,
  };
  credentials.set(key, entry);
  return entry;
}

/** Whether these params need an interactive sign-in, and who is signed in now. */
export function entraSignInRequirement(params: AuthParams): SignInRequirement {
  const entry = getEntraCredential(params);
  if (!entry || entry.kind === null) return { required: false, account: null };
  return { required: true, account: entry.account };
}

/**
 * Run the interactive sign-in, resolving with the signed-in account. `onPrompt`
 * fires with the device code (or the "browser opening" notice) as soon as
 * Microsoft issues it — well before this promise settles.
 */
export async function entraSignIn(
  params: AuthParams,
  onPrompt: (prompt: SignInPrompt) => void,
  signal?: AbortSignal,
): Promise<string> {
  const entry = getEntraCredential(params);
  if (!entry || entry.kind === null) {
    throw new ConnectionError('This authentication mode does not use an interactive sign-in.');
  }
  const credential = entry.credential as AuthenticatingCredential;
  if (entry.kind === 'browser') {
    // The browser flow has no code to relay, so announce it ourselves — the
    // dialog would otherwise sit blank while the system browser opens.
    onPrompt({
      kind: 'browser',
      message: 'Finish signing in to Microsoft in the browser window that just opened.',
    });
  }
  entry.sink.current = onPrompt;
  try {
    const record = await credential.authenticate(SQL_SCOPE, signal ? { abortSignal: signal } : {});
    entry.account = record?.username ?? 'signed in';
    return entry.account;
  } finally {
    entry.sink.current = undefined;
  }
}

/**
 * Make sure a token is available before we hand the credential to tedious, so a
 * missing sign-in surfaces as a clean SIGN_IN_REQUIRED rather than an opaque
 * federated-auth failure from deep inside the login handshake.
 */
export async function ensureEntraToken(params: AuthParams): Promise<void> {
  const entry = getEntraCredential(params);
  if (!entry) return;
  if (entry.kind !== null && !entry.account) {
    // Nobody has signed in on this credential yet; no point going to the
    // network (and this keeps the check working offline).
    throw new SignInRequiredError(
      'Sign in with Microsoft Entra ID to use this connection.',
    );
  }
  try {
    await entry.credential.getToken(SQL_SCOPE);
  } catch (err) {
    if (entry.kind !== null) {
      throw new SignInRequiredError(
        `Your Microsoft sign-in has expired or was revoked (${(err as Error).message}). Sign in again to continue.`,
        { cause: err },
      );
    }
    throw new ConnectionError(
      `Could not get a Microsoft Entra token from the Azure CLI: ${(err as Error).message} ` +
        `Run "az login" (or pick another authentication mode) and try again.`,
      { cause: err },
    );
  }
}

/**
 * Drop the cached credential (and with it the MSAL token cache) for these
 * params, so the next sign-in starts from nothing.
 *
 * This is what makes "switch account" mean something: a credential that still
 * holds a valid session authenticates *silently*, handing back the same account
 * without ever prompting. Forgetting it first forces a real, visible sign-in
 * where another account can be chosen. Connections already open keep the
 * credential they were given and go on working until they are closed.
 *
 * Local only — Microsoft is not told anything, and no browser session is signed
 * out. Anyone at this machine's browser may still be signed in there.
 */
export function forgetEntraCredential(params: AuthParams): void {
  const mode = entraMode(params);
  if (mode) credentials.delete(cacheKey(params, mode));
}

/** Forget every cached credential — used by tests. */
export function resetEntraCredentials(): void {
  credentials.clear();
}
