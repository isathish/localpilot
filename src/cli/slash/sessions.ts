import { SessionStore } from '../../sessions/sessionStore';
import { Session } from '../../types';
import { Style } from '../providers';
import { findSession, newestFirst, pickSession, sessionRows } from '../sessions';

export interface SessionSlashContext {
  store: SessionStore;
  /** The chat the REPL is in. */
  current: () => Session;
  /** Make `s` the REPL's chat; false when it cannot switch now (the reason was printed). */
  switchTo: (s: Session, how: 'Resumed' | 'Forked') => boolean;
  ask: (q: string) => Promise<string | undefined>;
  style: Style;
  out?: NodeJS.WritableStream;
}

/** `/history`, `/resume [N|id]` and `/fork [name]` in the REPL. Returns false for any other command. */
export async function sessionSlash(cmd: string, arg: string, ctx: SessionSlashContext): Promise<boolean> {
  const st = ctx.style;
  const out = ctx.out ?? process.stdout;
  const say = (t: string) => out.write(`${t}\n`);
  const cur = ctx.current();
  switch (cmd) {
    case 'history': {
      const list = newestFirst(ctx.store.list());
      if (!list.length) {
        say(st.dim('No saved sessions in this folder yet.'));
        return true;
      }
      const limit = /^\d+$/.test(arg) ? Math.max(1, Number(arg)) : 20;
      say(sessionRows(list.slice(0, limit), st, { current: cur.id }).join('\n'));
      say(st.dim(`${list.length > limit ? `${limit} of ${list.length} shown (/history ${list.length} for all). ` : ''}/resume <number> to switch, /fork [name] to branch this one.`));
      return true;
    }
    case 'resume': {
      const list = newestFirst(ctx.store.list());
      let target = arg ? undefined : await pickSession(list, st, ctx.ask, out, cur.id);
      if (arg) {
        const hit = findSession(list, arg);
        if (!hit.session) {
          say(st.red(hit.ambiguous ? `"${arg}" matches ${hit.ambiguous.length} sessions — use more of the id` : `no session "${arg}" — /history lists them`));
          return true;
        }
        target = hit.session;
      }
      if (!target) {
        return true;
      }
      if (target.id === cur.id) {
        say(st.dim('already in this session'));
        return true;
      }
      const s = ctx.store.get(target.id);
      if (!s) {
        say(st.red(`could not read session ${target.id}`));
        return true;
      }
      ctx.switchTo(s, 'Resumed');
      return true;
    }
    case 'fork': {
      ctx.store.save(cur, true);
      const s = ctx.store.fork(cur.id);
      if (!s) {
        say(st.red('this session could not be forked'));
        return true;
      }
      if (arg) {
        ctx.store.rename(s.id, arg);
      }
      if (!ctx.switchTo(s, 'Forked')) {
        void ctx.store.delete(s.id);
      }
      return true;
    }
    default:
      return false;
  }
}
