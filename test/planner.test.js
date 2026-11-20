import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planUpgrade, compareVersions } from '../src/planner.js';

const MESH = {
  controllerVersion: '1.22.0',
  minControllerVersion: '1.21.0',
  targetSidecarVersion: '1.22.0',
  targetSidecarImage: 'mesh/proxyv2:1.22.0',
  rollbackVersion: '1.21.1',
  rollbackImage: 'mesh/proxyv2:1.21.1',
};

function baseSnapshot(overrides = {}) {
  return {
    mesh: { ...MESH, ...(overrides.mesh ?? {}) },
    injectionTemplates: overrides.injectionTemplates ?? [
      { name: 'default', sidecarVersion: '1.22.0', sidecarImage: 'mesh/proxyv2:1.22.0' },
    ],
    workloads: overrides.workloads ?? [
      {
        name: 'checkout',
        namespace: 'shop',
        template: 'default',
        pods: [
          { name: 'checkout-0', sidecarVersion: '1.21.1', ready: true, connections: 0, orphans: [] },
          { name: 'checkout-1', sidecarVersion: '1.21.1', ready: true, connections: 0, orphans: [] },
        ],
      },
    ],
  };
}

test('compareVersions 正确比较语义版本', () => {
  assert.equal(compareVersions('1.22.0', '1.21.9'), 1);
  assert.equal(compareVersions('1.21.0', '1.21.0'), 0);
  assert.equal(compareVersions('1.20.9', '1.21.0'), -1);
});

test('正常升级：生成四阶段计划与 Pod 级动作', () => {
  const plan = planUpgrade(baseSnapshot());
  assert.equal(plan.status, 'ready');
  assert.deepEqual(
    plan.phases.map((p) => p.id),
    ['preflight', 'canary', 'rollout', 'finalize'],
  );
  // 金丝雀 1 个 + rollout 1 个
  const canary = plan.phases.find((p) => p.id === 'canary');
  const rollout = plan.phases.find((p) => p.id === 'rollout');
  assert.equal(canary.gate.pods.length, 1);
  assert.equal(rollout.gate.pods.length, 1);
  // 每个 Pod 都有完整步骤与回滚序列
  for (const pp of plan.podPlans) {
    assert.equal(pp.status, 'planned');
    const actions = pp.steps.map((s) => s.action);
    assert.deepEqual(actions, [
      'precheck',
      'start-new-proxy',
      'validate-config',
      'shift-traffic',
      'drain-old-proxy',
      'stop-old-proxy',
      'cleanup-orphans',
      'verify-pod',
    ]);
    assert.ok(pp.rollback.length >= 3);
  }
});

test('流量必须在新代理通过配置验证后才能移入', () => {
  const plan = planUpgrade(baseSnapshot());
  for (const pp of plan.podPlans) {
    const validate = pp.steps.find((s) => s.action === 'validate-config');
    const shift = pp.steps.find((s) => s.action === 'shift-traffic');
    assert.equal(validate.gate, 'config-validated');
    assert.equal(shift.requiresGate, 'config-validated');
    assert.ok(validate.order < shift.order, 'validate-config 必须先于 shift-traffic');
    assert.equal(validate.onFailure, 'abort-pod-and-rollback');
  }
});

test('旧代理停止后注入模板不得再引用旧版本', () => {
  const plan = planUpgrade(baseSnapshot());
  const finalize = plan.phases.find((p) => p.id === 'finalize');
  const retire = finalize.actions.find((a) => a.action === 'retire-old-template-references');
  assert.ok(retire, 'finalize 阶段必须包含退役旧模板引用动作');
  assert.match(finalize.gate.condition, /不再引用旧 sidecar 版本/);
  // finalize 必须在所有 Pod 阶段之后
  const ids = plan.phases.map((p) => p.id);
  assert.ok(ids.indexOf('finalize') > ids.indexOf('rollout'));
});

test('注入版本错配：预检阶段安排模板同步并给出警告', () => {
  const plan = planUpgrade(
    baseSnapshot({
      injectionTemplates: [
        { name: 'default', sidecarVersion: '1.21.1', sidecarImage: 'mesh/proxyv2:1.21.1' },
      ],
    }),
  );
  assert.equal(plan.status, 'ready');
  const mismatch = plan.warnings.find((w) => w.code === 'injection-version-mismatch');
  assert.ok(mismatch, '必须报告注入版本错配警告');
  const preflight = plan.phases.find((p) => p.id === 'preflight');
  const sync = preflight.actions.find((a) => a.action === 'sync-injection-template');
  assert.ok(sync, '预检阶段必须先同步注入模板');
  assert.equal(sync.from, '1.21.1');
  assert.equal(sync.to, '1.22.0');
});

test('注入模板缺失：整体阻塞', () => {
  const plan = planUpgrade(
    baseSnapshot({
      workloads: [
        {
          name: 'pay',
          namespace: 'shop',
          template: 'nonexistent',
          pods: [{ name: 'pay-0', sidecarVersion: '1.21.1', ready: true, connections: 0 }],
        },
      ],
    }),
  );
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.blockers.some((b) => b.code === 'injection-template-missing'));
  assert.equal(plan.podPlans.length, 0);
});

test('启动失败（Pod 未就绪）：跳过该 Pod 并保留现场', () => {
  const plan = planUpgrade(
    baseSnapshot({
      workloads: [
        {
          name: 'checkout',
          namespace: 'shop',
          template: 'default',
          pods: [
            { name: 'checkout-bad', sidecarVersion: '1.21.1', ready: false, connections: 3 },
          ],
        },
      ],
    }),
  );
  const pp = plan.podPlans.find((p) => p.pod === 'checkout-bad');
  assert.equal(pp.status, 'aborted');
  assert.equal(pp.abortReason, 'pod-not-ready');
  assert.equal(pp.steps[0].status, 'blocked');
  assert.equal(pp.rollback[0].action, 'no-op-keep-current');
  assert.ok(plan.warnings.some((w) => w.code === 'pod-not-ready'));
});

test('启动失败兜底：每个 Pod 计划都带配置验证失败后的回滚序列', () => {
  const plan = planUpgrade(baseSnapshot());
  for (const pp of plan.podPlans) {
    const actions = pp.rollback.map((r) => r.action);
    assert.ok(actions.includes('restore-old-proxy'));
    assert.ok(actions.includes('remove-failed-new-proxy'));
    const restore = pp.rollback.find((r) => r.action === 'restore-old-proxy');
    assert.equal(restore.image, MESH.rollbackImage);
    // 回滚后的代理也必须通过验证才能承接流量
    const validateRollback = pp.rollback.find((r) => r.action === 'validate-rollback');
    assert.equal(validateRollback.gate, 'rollback-validated');
  }
});

test('连接残留：安排排空等待与强制终止兜底', () => {
  const plan = planUpgrade(
    baseSnapshot({
      workloads: [
        {
          name: 'checkout',
          namespace: 'shop',
          template: 'default',
          pods: [
            { name: 'checkout-busy', sidecarVersion: '1.21.1', ready: true, connections: 17 },
          ],
        },
      ],
    }),
  );
  const pp = plan.podPlans[0];
  const actions = pp.steps.map((s) => s.action);
  assert.ok(actions.includes('wait-drain'));
  assert.ok(actions.includes('force-terminate-residual'));
  // 强制终止仅在仍有残留时执行，且必须排在停止旧代理之前
  const force = pp.steps.find((s) => s.action === 'force-terminate-residual');
  const stop = pp.steps.find((s) => s.action === 'stop-old-proxy');
  assert.equal(force.onlyIf, 'residual-connections-remain');
  assert.ok(force.order < stop.order);
  assert.ok(plan.warnings.some((w) => w.code === 'residual-connections'));
});

test('无残留连接时不安排强制终止', () => {
  const plan = planUpgrade(baseSnapshot());
  for (const pp of plan.podPlans) {
    const actions = pp.steps.map((s) => s.action);
    assert.ok(!actions.includes('force-terminate-residual'));
    assert.ok(!actions.includes('wait-drain'));
  }
});

test('孤儿进程：停止旧代理后安排清理', () => {
  const plan = planUpgrade(
    baseSnapshot({
      workloads: [
        {
          name: 'checkout',
          namespace: 'shop',
          template: 'default',
          pods: [
            {
              name: 'checkout-orphan',
              sidecarVersion: '1.21.1',
              ready: true,
              connections: 0,
              orphans: ['envoy-pid-4242', 'pilot-agent-pid-4243'],
            },
          ],
        },
      ],
    }),
  );
  const pp = plan.podPlans[0];
  const cleanup = pp.steps.find((s) => s.action === 'cleanup-orphans');
  const stop = pp.steps.find((s) => s.action === 'stop-old-proxy');
  assert.deepEqual(cleanup.processes, ['envoy-pid-4242', 'pilot-agent-pid-4243']);
  assert.ok(stop.order < cleanup.order, '孤儿清理必须在旧代理停止之后');
  const finalize = plan.phases.find((p) => p.id === 'finalize');
  assert.ok(finalize.actions.some((a) => a.action === 'verify-orphan-cleanup'));
});

test('控制器降级：整体阻塞并给出回滚计划', () => {
  const plan = planUpgrade(
    baseSnapshot({ mesh: { controllerVersion: '1.20.0' } }),
  );
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.blockers.some((b) => b.code === 'controller-downgrade'));
  assert.equal(plan.podPlans.length, 0);
  // 回滚计划：模板回退到回滚版本，保证新建 Pod 与现存代理一致
  const restore = plan.rollbackPlan.steps.find(
    (s) => s.action === 'restore-injection-template',
  );
  assert.equal(restore.version, MESH.rollbackVersion);
});

test('全局回滚计划包含停批、逐 Pod 回滚与一致性校验', () => {
  const plan = planUpgrade(baseSnapshot());
  const actions = plan.rollbackPlan.steps.map((s) => s.action);
  assert.deepEqual(actions, [
    'halt-remaining-batches',
    'rollback-in-flight-pods',
    'restore-injection-template',
    'verify-mesh-consistency',
  ]);
  const rollbackPods = plan.rollbackPlan.steps.find(
    (s) => s.action === 'rollback-in-flight-pods',
  );
  assert.equal(rollbackPods.image, MESH.rollbackImage);
});

test('已是目标版本的 Pod 标记为 noop', () => {
  const plan = planUpgrade(
    baseSnapshot({
      workloads: [
        {
          name: 'checkout',
          namespace: 'shop',
          template: 'default',
          pods: [
            { name: 'checkout-done', sidecarVersion: '1.22.0', ready: true, connections: 0 },
          ],
        },
      ],
    }),
  );
  assert.equal(plan.podPlans[0].status, 'noop');
  assert.equal(plan.podPlans[0].steps[0].status, 'skip');
});
