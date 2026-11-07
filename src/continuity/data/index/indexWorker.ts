// worker_threads entry of the continuity index (bundled to dist/continuityWorker.js). Owns the sql.js database so
// full-text search, catch-up and rebuilds never block the extension host or the CLI. RPC: { id, method, args } ->
// { id, ok, result | error }; notifications { event: 'progress' | 'applied' | 'log', ... }.
import { parentPort, workerData } from 'worker_threads';
import { dispatch } from './rpc';
import { EngineOptions, IndexEngine } from './engine';

type Init = Omit<EngineOptions, 'log' | 'onProgress' | 'onApplied' | 'now' | 'sqlJs'>;

if (parentPort) {
  const port = parentPort;
  const o = workerData as Init;
  const engine = new IndexEngine({
    ...o,
    watch: o.watch ?? true,
    log: (level, message) => port.postMessage({ event: 'log', level, message }),
    onProgress: (s) => port.postMessage({ event: 'progress', ...s }),
    onApplied: (n) => port.postMessage({ event: 'applied', ...n }),
  });
  const ready = engine.init().then(
    () => port.postMessage({ event: 'ready' }),
    (e: unknown) => port.postMessage({ event: 'failed', error: e instanceof Error ? e.message : String(e) })
  );
  port.on('message', (m: { id: number; method: string; args: unknown[] }) => {
    void ready
      .then(() => dispatch(engine, m.method, m.args ?? []))
      .then(
        (result) => port.postMessage({ id: m.id, ok: true, result }),
        (e: unknown) => port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
      )
      .then(() => {
        if (m.method === 'dispose') {
          port.close();
        }
      });
  });
}
