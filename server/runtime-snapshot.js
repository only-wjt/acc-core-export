// 运行中任务快照与重启恢复。
//
// 任务只在内存里跑，进程重启就全没了。这里做两件事：
//   1) 定时把在跑的任务"跑到哪一步"写盘（不含密码/session）；
//   2) 启动时把上次遗留的快照转成历史归档，未完成的账号标为 interrupted。
//
// 明确不做"自动续跑"：续跑需要凭据，而凭据按设计不落盘。恢复只提供可见性。
export function createRuntimeKeeper({
  store,
  managers,
  jobOwners,
  logger,
  intervalMs = Number(process.env.RUNTIME_SNAPSHOT_MS) || 10000,
  now = () => Date.now(),
} = {}) {
  let timer = null;

  async function snapshotRunning() {
    if (!store?.enabled) return 0;
    let written = 0;
    for (const [kind, mgr] of Object.entries(managers || {})) {
      let running = [];
      try {
        running = typeof mgr.listRunning === 'function' ? mgr.listRunning() : [];
      } catch {
        continue;
      }
      for (const job of running) {
        const file = await store.saveRuntime(kind, job, { owner: jobOwners?.get(job.id) || 'local' }).catch(() => null);
        if (file) written += 1;
      }
    }
    return written;
  }

  // 遗留快照 = 上次进程没跑完的任务。
  async function recover() {
    const leftovers = await store.loadRuntimes().catch(() => []);
    if (!leftovers.length) return 0;

    let recovered = 0;
    for (const snapshot of leftovers) {
      const kind = snapshot.kind;
      if (!managers?.[kind] || !snapshot.id) {
        // 未知类型：别让它一直躺在目录里
        await store.clearRuntime(kind, snapshot.id).catch(() => {});
        continue;
      }

      const items = (snapshot.items || []).map((item) => {
        // pending/running/done 都算"没跑完"：check 任务的 done 是成功项，但重启后
        // 无法确认结果是否已提交，统一按中断处理更诚实。
        const unfinished = item.status === 'pending' || item.status === 'running' || item.status === 'done';
        return {
          email: item.email,
          status: unfinished ? 'failed' : item.status,
          stage: unfinished ? '服务重启，任务中断' : (item.stage || ''),
          error: unfinished ? '服务重启，任务中断' : (item.error || ''),
          errorCategory: unfinished ? 'interrupted' : (item.errorCategory || ''),
          reason: '',
        };
      });

      const counts = {
        total: items.length,
        success: items.filter((item) => item.status === 'success').length,
        failed: items.filter((item) => item.status === 'failed').length,
        cancelled: items.filter((item) => item.status === 'cancelled').length,
      };

      const owner = snapshot.owner || 'local';
      await store.saveJob(kind, {
        id: snapshot.id,
        status: 'interrupted',
        createdAt: snapshot.createdAt,
        finishedAt: now(),
        counts,
        sessions: [],
        items,
      }, { owner }).catch(() => {});
      await store.clearRuntime(kind, snapshot.id).catch(() => {});
      if (jobOwners && !jobOwners.has(snapshot.id)) jobOwners.set(snapshot.id, owner);
      recovered += 1;
    }

    logger?.warn('发现未跑完的任务，已归档为中断', { recovered });
    return recovered;
  }

  function start() {
    if (timer || !store?.enabled) return false;
    timer = setInterval(() => { void snapshotRunning(); }, intervalMs);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { snapshotRunning, recover, start, stop };
}
