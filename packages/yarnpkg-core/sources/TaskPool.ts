import pLimit, {Limit} from 'p-limit';
import {Worker}        from 'worker_threads';

const kTaskInfo = Symbol(`kTaskInfo`);

type PoolWorker<TOut> = Worker & {
  [kTaskInfo]: null | {resolve: (value: TOut) => void, reject: (reason?: any) => void};
};

export interface TaskPool<TIn, TOut> {
  run(data: TIn): Promise<TOut>;
}

export class AsyncPool<TIn, TOut> implements TaskPool<TIn, TOut> {
  private limit: Limit;

  constructor(private fn: (data: TIn) => Promise<TOut>, opts: {poolSize: number}) {
    this.limit = pLimit(opts.poolSize);
  }

  run(data: TIn) {
    return this.limit(() => this.fn(data));
  }
}

export class WorkerPool<TIn, TOut> implements TaskPool<TIn, TOut> {
  private workers: Array<PoolWorker<TOut>> = [];

  private cleanupInterval: ReturnType<typeof setInterval>;

  private limit: Limit;

  constructor(private source: string, opts: {poolSize: number}) {
    this.limit = pLimit(opts.poolSize);

    this.cleanupInterval = setInterval(() => {
      if (this.limit.pendingCount === 0 && this.limit.activeCount === 0) {
        // Start terminating one worker at a time when there are no tasks left.
        // This allows the pool to scale down without having to re-create the
        // entire pool when there is a short amount of time without tasks.
        const worker = this.workers.pop();
        if (worker) {
          worker.terminate();
        } else {
          clearInterval(this.cleanupInterval);
        }
      }
    }, 5000).unref();
  }

  private createWorker() {
    this.cleanupInterval.refresh();

    const worker = new Worker(this.source, {
      eval: true,
      execArgv: [...process.execArgv, `--unhandled-rejections=strict`],
    }) as PoolWorker<TOut>;

    worker.on(`message`, (result: TOut) => {
      if (!worker[kTaskInfo])
        throw new Error(`Assertion failed: Worker sent a result without having a task assigned`);

      worker[kTaskInfo]!.resolve(result);
      worker[kTaskInfo] = null;

      worker.unref();
      this.workers.push(worker);
    });

    worker.on(`error`, err => {
      worker[kTaskInfo]?.reject(err);
      worker[kTaskInfo] = null;
    });

    worker.on(`exit`, code => {
      if (code !== 0)
        worker[kTaskInfo]?.reject(new Error(`Worker exited with code ${code}`));

      worker[kTaskInfo] = null;
    });

    return worker;
  }

  run(data: TIn) {
    return this.limit(() => {
      const worker = this.workers.pop() ?? this.createWorker();
      worker.ref();

      return new Promise<TOut>((resolve, reject) => {
        worker[kTaskInfo] = {resolve, reject};
        worker.postMessage(data);
      });
    });
  }
}
