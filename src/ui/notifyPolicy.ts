/** When LocalPilot raises native notifications (`localpilot.notifications`). Pure: no vscode. */

export type NotifyMode = 'whenHidden' | 'always' | 'off';

/** An auto-approved command still running after this long gets a notice. */
export const LONG_COMMAND_MS = 30_000;
/** A run that finishes normally gets a notification only after this long; errors and runs that need you always do. */
export const LONG_RUN_MS = 20_000;
/** The CLI rings the terminal bell after runs longer than this. */
export const BELL_AFTER_MS = 10_000;

/** `always`, or `whenHidden` while the chat is not visible or the window has no focus. */
export function shouldNotify(mode: NotifyMode, chatVisible: boolean, windowFocused: boolean): boolean {
  return mode === 'always' || (mode === 'whenHidden' && (!chatVisible || !windowFocused));
}

/** The CLI writes `\x07` when a run took longer than 10 s, stdout is a terminal and notifications are not off. */
export function shouldRingBell(mode: NotifyMode, isTTY: boolean, durationMs: number): boolean {
  return mode !== 'off' && isTTY && durationMs > BELL_AFTER_MS;
}

/**
 * Whether a finished run gets a native notification: never when {@link shouldNotify} says no; with `always` every run;
 * with `whenHidden` a run that failed or needs attention, or one that took at least {@link LONG_RUN_MS}.
 */
export function shouldNotifyFinish(mode: NotifyMode, chatVisible: boolean, windowFocused: boolean, durationMs: number, outcome: 'ok' | 'error' | 'attention'): boolean {
  if (!shouldNotify(mode, chatVisible, windowFocused)) {
    return false;
  }
  return mode === 'always' || outcome !== 'ok' || durationMs >= LONG_RUN_MS;
}
