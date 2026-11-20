/**
 * Sidecar 升级规划器（纯函数，不调用任何集群 API）。
 *
 * 输入：集群快照（工作负载、sidecar 版本、注入模板、就绪状态、连接数、
 *       控制器版本、回滚镜像）。
 * 输出：Pod 级动作序列、阶段门槛（gate）与回滚点。
 *
 * 核心约束：
 *  1. 新代理必须通过配置验证（config-validation gate）后才能移入流量。
 *  2. 旧代理停止后，注入模板不得再引用旧版本（finalize 阶段统一退役）。
 *  3. 控制器版本低于目标 sidecar 所需最低版本（控制器降级）时整体阻塞。
 */

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

const DEFAULT_OPTIONS = {
  canaryCount: 1,
  drainGraceSeconds: 30,
  maxResidualWaitSeconds: 120,
};

/**
 * @param {object} snapshot 集群快照
 * @param {object} snapshot.mesh 网格信息：
 *   { controllerVersion, minControllerVersion, targetSidecarVersion,
 *     targetSidecarImage, rollbackVersion, rollbackImage }
 * @param {Array}  snapshot.injectionTemplates 注入模板：
 *   [{ name, sidecarVersion, sidecarImage }]
 * @param {Array}  snapshot.workloads 工作负载：
 *   [{ name, namespace, template, pods: [{ name, sidecarVersion, ready,
 *      connections, orphans }] }]
 * @param {object} [options] { canaryCount, drainGraceSeconds, maxResidualWaitSeconds }
 */
export function planUpgrade(snapshot, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const mesh = snapshot.mesh ?? {};
  const templates = new Map(
    (snapshot.injectionTemplates ?? []).map((t) => [t.name, t]),
  );
  const workloads = snapshot.workloads ?? [];

  const blockers = [];
  const warnings = [];
  const phases = [];

  // ---------- 阶段 0：预检（控制器版本 + 注入模板） ----------
  const preflightActions = [];

  const controllerDowngraded =
    mesh.controllerVersion &&
    mesh.minControllerVersion &&
    compareVersions(mesh.controllerVersion, mesh.minControllerVersion) < 0;

  if (controllerDowngraded) {
    blockers.push({
      code: 'controller-downgrade',
      detail:
        `控制器版本 ${mesh.controllerVersion} 低于目标 sidecar ` +
        `${mesh.targetSidecarVersion} 所需的最低版本 ${mesh.minControllerVersion}`,
    });
  }

  const templateMismatches = [];
  for (const wl of workloads) {
    const tpl = templates.get(wl.template);
    if (!tpl) {
      blockers.push({
        code: 'injection-template-missing',
        detail: `工作负载 ${wl.namespace}/${wl.name} 引用的注入模板 "${wl.template}" 不存在`,
      });
      continue;
    }
    if (tpl.sidecarVersion !== mesh.targetSidecarVersion) {
      templateMismatches.push({ workload: wl, template: tpl });
    }
  }

  for (const { workload, template } of templateMismatches) {
    warnings.push({
      code: 'injection-version-mismatch',
      detail:
        `注入模板 "${template.name}" 版本 ${template.sidecarVersion} 与目标 ` +
        `${mesh.targetSidecarVersion} 不一致（${workload.namespace}/${workload.name}），` +
        `须先同步模板，否则新 Pod 会被注入旧代理`,
    });
    preflightActions.push({
      action: 'sync-injection-template',
      template: template.name,
      from: template.sidecarVersion,
      to: mesh.targetSidecarVersion,
      image: mesh.targetSidecarImage,
      description:
        `将注入模板 "${template.name}" 从 ${template.sidecarVersion} 更新到 ` +
        `${mesh.targetSidecarVersion}，避免新 Pod 注入旧代理`,
    });
  }

  phases.push({
    id: 'preflight',
    name: '预检：控制器版本与注入模板同步',
    gate: {
      id: 'preflight-passed',
      condition:
        '控制器版本 >= minControllerVersion，且所有注入模板版本 == 目标 sidecar 版本',
      blocksOn: blockers.map((b) => b.code),
    },
    actions: preflightActions,
  });

  if (blockers.length > 0) {
    return {
      status: 'blocked',
      blockers,
      warnings,
      phases,
      podPlans: [],
      rollbackPlan: buildGlobalRollback(mesh, '预检失败：不执行任何 Pod 变更'),
    };
  }

  // ---------- Pod 级计划 ----------
  const allPods = [];
  for (const wl of workloads) {
    for (const pod of wl.pods ?? []) {
      allPods.push({ workload: wl, pod });
    }
  }

  const podPlans = allPods.map(({ workload, pod }, index) =>
    planPod(workload, pod, index < opts.canaryCount ? 0 : 1, mesh, opts, warnings),
  );

  const canaryPlans = podPlans.filter((p) => p.batch === 0);
  const rolloutPlans = podPlans.filter((p) => p.batch === 1);

  phases.push({
    id: 'canary',
    name: '金丝雀：首批 Pod 代理替换',
    gate: {
      id: 'canary-healthy',
      condition:
        '全部金丝雀 Pod 的新代理通过配置验证、就绪且旧代理连接数降为 0',
      pods: canaryPlans.map((p) => p.pod),
    },
    actions: canaryPlans.flatMap((p) =>
      p.steps.map((s) => ({ pod: p.pod, ...s })),
    ),
  });

  phases.push({
    id: 'rollout',
    name: '批量 rollout：剩余 Pod 代理替换',
    gate: {
      id: 'rollout-complete',
      condition: '所有剩余 Pod 完成代理替换并通过验证',
      pods: rolloutPlans.map((p) => p.pod),
    },
    actions: rolloutPlans.flatMap((p) =>
      p.steps.map((s) => ({ pod: p.pod, ...s })),
    ),
  });

  // ---------- 收尾：退役旧模板引用 + 孤儿清理确认 ----------
  phases.push({
    id: 'finalize',
    name: '收尾：退役旧版本引用并确认孤儿进程清理',
    gate: {
      id: 'old-version-unreferenced',
      condition:
        '所有 Pod 运行目标版本，注入模板不再引用旧 sidecar 版本，无残留孤儿进程',
    },
    actions: [
      {
        action: 'retire-old-template-references',
        description:
          '确认注入模板仅引用目标版本，删除旧版本模板/镜像引用，' +
          '保证已停止的旧代理不会被新 Pod 再次注入',
      },
      {
        action: 'verify-orphan-cleanup',
        description: '确认所有 Pod 的孤儿代理进程已终止且无残留连接',
      },
    ],
  });

  return {
    status: 'ready',
    blockers,
    warnings,
    phases,
    podPlans,
    rollbackPlan: buildGlobalRollback(
      mesh,
      '任一阶段门槛未通过：停止后续批次，按 Pod 回滚点逐 Pod 回滚',
    ),
  };
}

function planPod(workload, pod, batch, mesh, opts, warnings) {
  const podRef = `${workload.namespace}/${pod.name}`;
  const steps = [];
  const rollback = [];
  let order = 0;
  const next = () => (order += 1);

  const alreadyOnTarget = pod.sidecarVersion === mesh.targetSidecarVersion;
  const notReady = pod.ready === false;

  // 1. 预检
  steps.push({
    order: next(),
    action: 'precheck',
    description: `确认 Pod ${podRef} 就绪且当前 sidecar ${pod.sidecarVersion} 需要升级`,
    status: notReady ? 'blocked' : alreadyOnTarget ? 'skip' : 'pending',
    reason: notReady
      ? 'Pod 未就绪，跳过升级并保留现场'
      : alreadyOnTarget
        ? '已是目标版本'
        : undefined,
  });

  if (notReady) {
    warnings.push({
      code: 'pod-not-ready',
      detail: `Pod ${podRef} 未就绪，代理替换被跳过，需人工确认后重试`,
    });
    return {
      pod: pod.name,
      workload: workload.name,
      namespace: workload.namespace,
      batch,
      status: 'aborted',
      abortReason: 'pod-not-ready',
      steps,
      rollback: [
        {
          order: 1,
          action: 'no-op-keep-current',
          description: '未做任何变更，保持当前代理运行',
        },
      ],
    };
  }

  if (alreadyOnTarget) {
    return {
      pod: pod.name,
      workload: workload.name,
      namespace: workload.namespace,
      batch,
      status: 'noop',
      steps,
      rollback: [],
    };
  }

  // 2. 启动新代理（替换 sidecar 镜像）
  steps.push({
    order: next(),
    action: 'start-new-proxy',
    image: mesh.targetSidecarImage,
    description:
      `在 ${podRef} 启动新代理 ${mesh.targetSidecarImage}（旧代理继续承载流量）`,
    status: 'pending',
  });

  // 3. 门槛：配置验证 —— 必须通过才能移入流量
  steps.push({
    order: next(),
    action: 'validate-config',
    gate: 'config-validated',
    description:
      '对新代理执行配置验证（xDS 订阅、监听器/集群加载、就绪探针）；' +
      '未通过前禁止移入流量',
    status: 'pending',
    onFailure: 'abort-pod-and-rollback',
  });

  // 4. 移入流量（仅在上一步门槛通过后）
  steps.push({
    order: next(),
    action: 'shift-traffic',
    requiresGate: 'config-validated',
    rollbackPoint: true,
    description: '将新连接调度到新代理，旧代理标记为不再接收新连接',
    status: 'pending',
  });

  // 5. 摘除旧代理流量并等待连接排空
  const hasResidual = (pod.connections ?? 0) > 0;
  steps.push({
    order: next(),
    action: 'drain-old-proxy',
    description:
      `从负载均衡摘除旧代理，等待 ${pod.connections ?? 0} 条存量连接排空` +
      `（宽限 ${opts.drainGraceSeconds}s）`,
    status: 'pending',
  });
  if (hasResidual) {
    steps.push({
      order: next(),
      action: 'wait-drain',
      description:
        `连接残留：最长等待 ${opts.maxResidualWaitSeconds}s 至连接数降为 0`,
      status: 'pending',
      timeoutSeconds: opts.maxResidualWaitSeconds,
    });
    steps.push({
      order: next(),
      action: 'force-terminate-residual',
      description:
        '超过宽限期仍有残留连接时强制终止，并记录被中断的连接',
      status: 'pending',
      onlyIf: 'residual-connections-remain',
    });
    warnings.push({
      code: 'residual-connections',
      detail:
        `Pod ${podRef} 旧代理仍有 ${pod.connections} 条连接，` +
        `已安排排空等待与强制终止兜底`,
    });
  }

  // 6. 停止旧代理（回滚点：此前都可无损回滚）
  steps.push({
    order: next(),
    action: 'stop-old-proxy',
    rollbackPoint: true,
    description:
      '停止旧代理进程；停止后注入模板必须已不再引用该版本（见 finalize 阶段）',
    status: 'pending',
  });

  // 7. 孤儿进程清理
  const orphans = pod.orphans ?? [];
  if (orphans.length > 0) {
    steps.push({
      order: next(),
      action: 'cleanup-orphans',
      processes: orphans,
      description: `终止 ${orphans.length} 个孤儿代理进程：${orphans.join(', ')}`,
      status: 'pending',
    });
  } else {
    steps.push({
      order: next(),
      action: 'cleanup-orphans',
      processes: [],
      description: '扫描并确认无孤儿代理进程',
      status: 'pending',
    });
  }

  // 8. 验证
  steps.push({
    order: next(),
    action: 'verify-pod',
    description: '确认新代理就绪、连接数正常、无残留旧进程',
    status: 'pending',
  });

  // 回滚序列（配置验证失败或后续阶段失败时执行）
  rollback.push({
    order: 1,
    action: 'shift-traffic-back',
    description: '将流量切回旧代理（若旧代理仍存活）',
  });
  rollback.push({
    order: 2,
    action: 'restore-old-proxy',
    image: mesh.rollbackImage,
    description:
      `若旧代理已停止，使用回滚镜像 ${mesh.rollbackImage}（版本 ${mesh.rollbackVersion}）重启`,
  });
  rollback.push({
    order: 3,
    action: 'validate-rollback',
    gate: 'rollback-validated',
    description: '回滚后的代理同样必须通过配置验证才能承接流量',
  });
  rollback.push({
    order: 4,
    action: 'remove-failed-new-proxy',
    description: '移除启动失败/验证未通过的新代理，避免半升级状态',
  });

  return {
    pod: pod.name,
    workload: workload.name,
    namespace: workload.namespace,
    batch,
    status: 'planned',
    steps,
    rollback,
  };
}

function buildGlobalRollback(mesh, trigger) {
  return {
    trigger,
    steps: [
      {
        order: 1,
        action: 'halt-remaining-batches',
        description: '停止所有未开始的 Pod 批次',
      },
      {
        order: 2,
        action: 'rollback-in-flight-pods',
        image: mesh.rollbackImage,
        description:
          `对已开始升级的 Pod 按各自回滚点回滚到 ${mesh.rollbackImage}`,
      },
      {
        order: 3,
        action: 'restore-injection-template',
        version: mesh.rollbackVersion,
        description:
          `将注入模板回退到 ${mesh.rollbackVersion}，保证新建 Pod 与现存代理版本一致`,
      },
      {
        order: 4,
        action: 'verify-mesh-consistency',
        description: '确认控制面与数据面版本恢复一致，无孤儿进程与残留连接',
      },
    ],
  };
}
