import * as http from 'http';
import { AddressInfo } from 'net';

/**
 * A scripted OpenAI-compatible model for the self-healing tests. Requests are routed by a marker in the
 * conversation's user messages (the task prompt, a fixer brief); the route sees the whole conversation and decides
 * the next reply: text or tool calls. Self-healing fix prompts arrive as (hidden) user messages starting with
 * `[LocalPilot self-healing`, so a route can tell "the task", "a fix attempt" and "after my tool call" apart. Routes
 * can also drop requests (the connection is cut before any answer) to simulate a model server that is down.
 */

export type Msg = { role: string; content?: unknown; tool_call_id?: string };

export const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? '').join('') : '');

export const FIX_PREFIX = '[LocalPilot self-healing';

export interface Turn {
  model: string;
  /** The route's match on the first user message that matched. */
  match: RegExpExecArray;
  users: string[];
  lastUser: string;
  /** Tool results after the last user message: 0 = the model has not acted on it yet. */
  toolsAfter: number;
  /** The last user message is a self-healing fix prompt. */
  fix: boolean;
  /** Fix prompts in the conversation so far. */
  fixes: number;
}

export type Reply = { text: string } | { calls: { name: string; args: Record<string, unknown> }[] };

export interface Route {
  re: RegExp;
  reply: (t: Turn) => Reply;
  /** Hold each answer this long (overlap measurements). */
  delayMs?: number;
  /** Cut the connection of the next N matching requests. */
  drop?: number;
}

export interface ModelRequest {
  route?: RegExp;
  model: string;
  users: string[];
  start: number;
  end: number;
  dropped?: boolean;
  tools: boolean;
}

export interface ScriptedModel {
  url: string;
  models: string[];
  reqs: ModelRequest[];
  /** Times of `/v1/models` requests (listing and health probes). */
  modelHits: number[];
  route(r: Route): () => void;
  close(): void;
}

export const say = (text: string): Reply => ({ text });
export const call = (name: string, args: Record<string, unknown>): Reply => ({ calls: [{ name, args }] });
export const write = (path: string, content: string): Reply => call('write_file', { path, content });

export function scriptedModel(models = ['m-heal']): Promise<ScriptedModel> {
  const routes: Route[] = [];
  const reqs: ModelRequest[] = [];
  const modelHits: number[] = [];
  let ids = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url?.startsWith('/v1/models')) {
        modelHits.push(Date.now());
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'heal', context_length: 32768 })) }));
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const j = JSON.parse(body) as { model: string; messages: Msg[]; tools?: unknown[] };
      const users = j.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
      const tools = !!j.tools?.length;
      let route: Route | undefined;
      let match: RegExpExecArray | null = null;
      if (tools) {
        for (const r of routes) {
          for (const u of users) {
            match = r.re.exec(u);
            if (match) {
              break;
            }
          }
          if (match) {
            route = r;
            break;
          }
        }
      }
      const rec: ModelRequest = { route: route?.re, model: j.model, users, start: Date.now(), end: 0, tools };
      reqs.push(rec);
      if (route && route.drop) {
        route.drop--;
        rec.dropped = true;
        rec.end = Date.now();
        req.socket.destroy();
        return;
      }
      let reply: Reply;
      if (!route || !match) {
        reply = say('Self-healing test');
      } else {
        let last = -1;
        j.messages.forEach((m, i) => {
          if (m.role === 'user') {
            last = i;
          }
        });
        const lastUser = last >= 0 ? textOf(j.messages[last].content) : '';
        reply = route.reply({
          model: j.model,
          match,
          users,
          lastUser,
          toolsAfter: j.messages.slice(last + 1).filter((m) => m.role === 'tool').length,
          fix: lastUser.trimStart().startsWith(FIX_PREFIX),
          fixes: users.filter((u) => u.trimStart().startsWith(FIX_PREFIX)).length,
        });
      }
      setTimeout(() => {
        res.setHeader('content-type', 'text/event-stream');
        if ('calls' in reply) {
          const calls = reply.calls.map((c, index) => ({ index, id: `call_${++ids}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.text } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
        rec.end = Date.now();
      }, route?.delayMs ?? 20);
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        models,
        reqs,
        modelHits,
        route: (r) => {
          routes.push(r);
          return () => {
            const i = routes.indexOf(r);
            if (i >= 0) {
              routes.splice(i, 1);
            }
          };
        },
        close: () => {
          srv.closeAllConnections?.();
          srv.close();
        },
      });
    })
  );
}
