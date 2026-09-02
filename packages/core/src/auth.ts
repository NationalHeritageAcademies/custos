/**
 * Interactive sign-in — the contract for auth modes whose credentials come from
 * an identity provider instead of a stored password (Microsoft Entra ID with
 * MFA today; any future SSO/OAuth engine tomorrow). Nothing here is
 * Azure-specific: a driver opts in by implementing {@link InteractiveAuthDriver},
 * and the app engine + UI drive it generically.
 *
 * The flow is deliberately poll-shaped. Both Custos hosts are request/response
 * only (Electron's `ipcRenderer.invoke` and the web host's `POST /api`), and a
 * device code has to reach the user *before* the sign-in finishes. So the
 * renderer starts a flow, gets the prompt straight back, then polls until the
 * identity provider says yes.
 */
import type { ConnectionConfig } from './types';
import type { DatabaseDriver } from './driver';

/** Non-secret connection params — the same bag as {@link ConnectionConfig.params}. */
export type AuthParams = ConnectionConfig['params'];

/** How the user completes a sign-in. */
export type SignInKind = 'device-code' | 'browser';

/** What the user must do to finish signing in, as reported by the provider. */
export interface SignInPrompt {
  readonly kind: SignInKind;
  /** The provider's own instruction text; shown when there is no code to render. */
  readonly message: string;
  /** Device code to type at {@link verificationUri}. */
  readonly userCode?: string;
  readonly verificationUri?: string;
}

export type SignInStatus = 'pending' | 'complete' | 'failed' | 'cancelled';

/** A sign-in flow in progress, or its outcome. Returned by begin and poll alike. */
export interface SignInState {
  readonly flowId: string;
  readonly status: SignInStatus;
  readonly prompt?: SignInPrompt;
  /** The signed-in account (e.g. an email), once the flow completes. */
  readonly account?: string;
  /** Failure detail when `status` is 'failed'. */
  readonly message?: string;
}

/** Whether a given set of connection params needs an interactive sign-in. */
export interface SignInRequirement {
  /** True when these params use an interactive auth mode. */
  readonly required: boolean;
  /** The account already signed in for these params, or null. */
  readonly account: string | null;
}

/**
 * Optional driver capability: some of this driver's auth modes sign the user in
 * interactively rather than reading a stored secret.
 *
 * `signIn` runs the interactive half — it resolves with the account name once
 * the provider confirms, and must call `onPrompt` as soon as it knows what to
 * show the user (a device code, or "your browser is opening"). Whatever tokens
 * result are the driver's business; the engine only tracks flow state.
 */
export interface InteractiveAuthDriver {
  signInRequirement(params: AuthParams): SignInRequirement;
  signIn(
    params: AuthParams,
    onPrompt: (prompt: SignInPrompt) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * Forget the local session for these params, so the next `signIn` prompts
   * from scratch. Implement this to support "switch account": a provider session
   * that is still valid signs the *same* account in again silently, with no
   * prompt and nothing for the user to change. Local only — no server-side
   * revoke is implied.
   */
  forgetSignIn?(params: AuthParams): void;
}

/** True when this driver supports interactive sign-in. */
export function isInteractiveAuthDriver(
  driver: DatabaseDriver,
): driver is DatabaseDriver & InteractiveAuthDriver {
  const candidate = driver as Partial<InteractiveAuthDriver>;
  return typeof candidate.signIn === 'function' && typeof candidate.signInRequirement === 'function';
}
