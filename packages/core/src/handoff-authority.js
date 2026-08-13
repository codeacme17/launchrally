function visibleEffect(task) {
  return `The external Executor may perform ${task.allowed_effects.join(", ")} on ${task.expected_target}.`;
}

export function createHandoffAuthorityBatch(tasks, executor) {
  return {
    effect_classes: [...new Set(tasks.map(({ effect_class: effect }) => effect))],
    target: tasks[0].expected_target,
    allowed_effects: [...new Set(tasks.flatMap(({ allowed_effects: effects }) => effects))].sort(),
    prohibited_effects: [...new Set(
      tasks.flatMap(({ prohibited_effects: effects }) => effects),
    )].sort(),
    user_visible_effects: [...new Set(tasks.map(visibleEffect))],
    coordination: {
      cancellation: executor.cancellation,
      task_cancellation_behaviors: [...new Set(
        tasks.map(({ cancellation_behavior: behavior }) => behavior),
      )].sort(),
      partial_failure: executor.partial_failure,
    },
    executor_requirements: {
      tools: executor.tools.map(({ tool_id: toolId, executable, exact_version: exactVersion }) => ({
        tool_id: toolId,
        executable,
        exact_version: exactVersion,
      })),
      auth_assumptions: [...executor.auth_assumptions],
      authentication_state: executor.authentication_state ?? "user_managed_unverified",
      secret_handling: executor.secret_handling,
    },
  };
}
