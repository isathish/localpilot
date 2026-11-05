/**
 * Smoke checks for src/agent/healing/scheduler.ts (design §5.3).
 *   node scripts/healing/run.js scripts/healing/scheduler.smoke.ts
 */
import {
  CheckSemaphore,
  RecoveryBus,
  RecoveryBusMessage,
  checkSemaphore,
  recoveryBus,
  rootSessionId,
  semaphoreKey,
} from "../../src/agent/healing/scheduler";
import type { Failure } from "../../src/agent/healing/types";

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

export async function schedulerSmoke(check: Check): Promise<void> {
  // no overlap with permits = 1, FIFO order
  {
    const sem = new CheckSemaphore(1);
    let running = 0;
    let overlap = false;
    const order: number[] = [];
    const job = (i: number) =>
      sem.run("/ws/a", async () => {
        running++;
        if (running > 1) {
          overlap = true;
        }
        order.push(i);
        await tick(5);
        running--;
      });
    await Promise.all([0, 1, 2, 3, 4].map(job));
    check("permits=1: no overlapping checks", !overlap);
    check("permits=1: FIFO order", order.join(",") === "0,1,2,3,4", order);
    check(
      "stats: max concurrent 1",
      sem.stats().maxConcurrent === 1,
      sem.stats(),
    );
    check(
      "stats: lanes pruned when idle",
      Object.keys(sem.stats().roots).length === 0,
      sem.stats(),
    );
  }

  // different roots do not block each other; same root normalised
  {
    const sem = new CheckSemaphore(1);
    const a = await sem.acquire("/ws/a");
    const b = await Promise.race([
      sem.acquire("/ws/b"),
      tick(20).then(() => null),
    ]);
    check("other root acquires immediately", typeof b === "function");
    const sameP = sem.acquire("/ws/a/../a");
    const same = await Promise.race([sameP, tick(20).then(() => null)]);
    check("same root (normalised path) waits", same === null);
    a();
    a();
    const sameRel = await sameP;
    const key = semaphoreKey("/ws/a");
    check(
      "double release is idempotent",
      sem.stats().roots[key]?.active === 1,
      sem.stats(),
    );
    const fourthP = sem.acquire("/ws/a");
    const fourth = await Promise.race([fourthP, tick(20).then(() => null)]);
    check("double release did not free an extra permit", fourth === null);
    sameRel();
    const fourthRel = await fourthP;
    fourthRel();
    const stats = sem.stats();
    b?.();
    check(
      "max concurrent across roots counts per root",
      stats.maxConcurrent === 1,
      stats,
    );
  }

  // permits = 2 allows two at once
  {
    const sem = new CheckSemaphore(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      [0, 1, 2, 3].map(() =>
        sem.run("/ws/p", async () => {
          running++;
          peak = Math.max(peak, running);
          await tick(5);
          running--;
        }),
      ),
    );
    check(
      "permits=2: peak concurrency 2",
      peak === 2 && sem.stats().maxConcurrent === 2,
      { peak },
    );
  }

  // abort while waiting: rejects, no leaked permit, queue order kept
  {
    const sem = new CheckSemaphore(1);
    const first = await sem.acquire("/ws/x");
    const ac = new AbortController();
    const aborted = sem.acquire("/ws/x", ac.signal);
    let thirdGot = false;
    const third = sem.acquire("/ws/x").then((rel) => {
      thirdGot = true;
      return rel;
    });
    await tick();
    ac.abort();
    let rejected: Error | undefined;
    try {
      await aborted;
    } catch (e) {
      rejected = e as Error;
    }
    check(
      "abort while waiting rejects with AbortError",
      rejected?.name === "AbortError",
      rejected,
    );
    check(
      "aborted waiter removed from queue",
      sem.stats().roots[Object.keys(sem.stats().roots)[0]]?.waiting === 1,
      sem.stats(),
    );
    check("third waiter still blocked while first holds", !thirdGot);
    first();
    const rel3 = await third;
    check("next waiter granted after release", thirdGot);
    rel3();
    await tick();
    check(
      "no permits leaked after abort",
      Object.keys(sem.stats().roots).length === 0,
      sem.stats(),
    );
    const pre = new AbortController();
    pre.abort();
    let preRejected = false;
    await sem.acquire("/ws/x", pre.signal).catch(() => (preRejected = true));
    check("already-aborted signal rejects immediately", preRejected);
    const again = await Promise.race([
      sem.acquire("/ws/x"),
      tick(20).then(() => null),
    ]);
    check(
      "permit available after pre-aborted acquire",
      typeof again === "function",
    );
    again?.();
  }

  check(
    "singleton checkSemaphore exported",
    checkSemaphore instanceof CheckSemaphore,
  );

  // bus routing
  {
    const bus = new RecoveryBus();
    check(
      "rootSessionId strips child suffix",
      rootSessionId("s1::w2::w3") === "s1" && rootSessionId("s1") === "s1",
    );
    const failure: Failure = {
      id: "f1",
      category: "typescript",
      cls: "deterministic",
      severity: "high",
      code: "TS2345",
      message: "Argument of type 'string' is not assignable",
      file: "src/a.ts",
      line: 3,
      evidence: "src/a.ts(3,5): error TS2345",
      source: { kind: "subagent" },
      signature: "abc",
      generic: "typescript:TS2345:argument-not-assignable",
      preexisting: false,
      foreign: false,
    };
    const got: { msg: RecoveryBusMessage; from: string }[] = [];
    const other: RecoveryBusMessage[] = [];
    const unsub = bus.subscribe("s1", (msg, from) => got.push({ msg, from }));
    bus.subscribe("s2", (msg) => other.push(msg));
    bus.subscribe("s1", () => {
      throw new Error("boom");
    });
    const n = bus.publish("s1::fix-1", {
      type: "worker_result",
      childId: "s1::fix-1",
      healthy: false,
      failures: [failure],
    });
    bus.publish("s1::fix-1::sub", {
      type: "worker_failure_detected",
      childId: "s1::fix-1::sub",
      failures: [],
    });
    bus.publish("s1::w2", {
      type: "child_write",
      childId: "s1::w2",
      phase: "before",
      paths: ["src/b.ts"],
    });
    bus.publish("s1::w2", {
      type: "child_write",
      childId: "s1::w2",
      phase: "after",
      paths: ["src/b.ts"],
    });
    check(
      "worker_result routed from child id to root",
      got[0]?.msg.type === "worker_result" && got[0].from === "s1::fix-1",
      got,
    );
    const first = got[0]?.msg;
    check(
      "worker failure keeps generic signature and RCA fields",
      first?.type === "worker_result" &&
        first.failures[0]?.generic ===
          "typescript:TS2345:argument-not-assignable" &&
        first.failures[0].evidence === failure.evidence &&
        first.failures[0].cls === "deterministic",
      first,
    );
    check(
      "handler error isolated (delivered count excludes thrower)",
      n === 1,
      n,
    );
    check(
      "nested child routed to root",
      got[1]?.msg.type === "worker_failure_detected",
    );
    const writes = got
      .filter((g) => g.msg.type === "child_write")
      .map((g) => g.msg);
    check(
      "child_write before/after routed to root",
      writes.length === 2 &&
        writes[0].type === "child_write" &&
        writes[0].phase === "before" &&
        writes[1].type === "child_write" &&
        writes[1].phase === "after",
      writes,
    );
    check("other root does not receive messages", other.length === 0, other);
    check(
      "publish with no subscribers returns 0",
      bus.publish("s9::x", {
        type: "worker_failure_detected",
        childId: "s9::x",
        failures: [],
      }) === 0,
    );
    unsub();
    bus.publish("s1", {
      type: "worker_failure_detected",
      childId: "s1",
      failures: [],
    });
    check("unsubscribe stops delivery", got.length === 4, got.length);
    check(
      "hasSubscribers reflects remaining handler",
      bus.hasSubscribers("s1::any") && !bus.hasSubscribers("s9"),
    );
    check("singleton recoveryBus exported", recoveryBus instanceof RecoveryBus);
  }
}
