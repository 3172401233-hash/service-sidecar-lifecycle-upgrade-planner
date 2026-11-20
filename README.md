# service-sidecar-lifecycle-upgrade-planner
规划 sidecar 升级、流量移交和孤儿代理清理

## 概述

离线规划器（Node.js 24.16.0，ESM），针对服务网格 sidecar 升级期间
控制面与数据面版本短暂不一致的窗口，根据集群快照生成升级计划：

- 输入：工作负载、sidecar 版本、注入模板、就绪状态、连接数、
  控制器版本、回滚镜像。
- 输出：Pod 级动作序列、阶段门槛（gate）与回滚点。

**本工具不调用任何集群 API**：它只是一个纯函数规划器，对传入的
快照对象进行推理并返回计划 JSON，不读写 Kubernetes / 网格控制面。

## 使用

```js
import { planUpgrade } from './src/planner.js';

const plan = planUpgrade({
  mesh: {
    controllerVersion: '1.22.0',
    minControllerVersion: '1.21.0',
    targetSidecarVersion: '1.22.0',
    targetSidecarImage: 'mesh/proxyv2:1.22.0',
    rollbackVersion: '1.21.1',
    rollbackImage: 'mesh/proxyv2:1.21.1',
  },
  injectionTemplates: [
    { name: 'default', sidecarVersion: '1.21.1', sidecarImage: 'mesh/proxyv2:1.21.1' },
  ],
  workloads: [
    {
      name: 'checkout', namespace: 'shop', template: 'default',
      pods: [
        { name: 'checkout-0', sidecarVersion: '1.21.1', ready: true, connections: 12, orphans: [] },
      ],
    },
  ],
});
```

## 计划结构

- `phases`：`preflight`（控制器版本 + 注入模板同步）→ `canary` →
  `rollout` → `finalize`（退役旧模板引用、确认孤儿清理），每阶段带
  `gate` 门槛，未通过则触发全局回滚。
- `podPlans[].steps`：`precheck → start-new-proxy → validate-config
  （gate: config-validated）→ shift-traffic → drain-old-proxy →
  stop-old-proxy → cleanup-orphans → verify-pod`。
  新代理必须通过配置验证后才能移入流量；旧代理停止后，finalize 阶段
  确保注入模板不再引用旧版本。
- `podPlans[].rollback` 与 `rollbackPlan`：Pod 级与全局回滚点，
  使用 `rollbackImage` 恢复旧代理并回退注入模板。

## 覆盖的异常场景

- 注入版本错配：预检阶段先同步模板（`sync-injection-template`）并告警。
- 启动失败：未就绪 Pod 跳过并保留现场；配置验证失败触发 Pod 级回滚序列。
- 连接残留：排空等待（`wait-drain`）+ 超时强制终止（`force-terminate-residual`）。
- 控制器降级：控制器版本低于 `minControllerVersion` 时整体阻塞并给出回滚计划。

## 测试

```sh
node --test
```
