/**
 * model.ts —— 从 ACP 会话的配置项里解析/校验要用的模型（纯函数，不依赖 ACP SDK，便于单测）。
 *
 * opencode 的 ACP 在 session/new 响应里给出一个配置项（id/category 为 "model"，type "select"），
 * 客户端可经 `session/set_config_option` 指定模型——这是给 `opencode acp` 选模型的唯一途径
 * （`opencode acp` 没有 --model 参数，也不会用命令行指定的模型）。
 *
 * 若不设置，opencode 会用它自己的默认模型（可能既贵又不是你想要的），因此这里要求显式配置；
 * 配置了却不在可选列表内（多半是 provider 大小写或模型名写错）会直接抛错，不做静默回退。
 */

/** ACP 模型配置项的最小形状（宽容解析，不绑定 SDK 类型）。 */
export type ModelOption = {
  id: string;
  category?: string | null;
  options?: ReadonlyArray<{ value: string } | { options: ReadonlyArray<{ value: string }> }> | null;
};

/** 把 select 选项（可能是分组）里的所有可选值摊平成一个集合。 */
function optionValues(option: ModelOption): Set<string> {
  const values = new Set<string>();
  for (const entry of option.options ?? []) {
    if ("value" in entry && typeof entry.value === "string") values.add(entry.value);
    else if ("options" in entry) for (const sub of entry.options) values.add(sub.value);
  }
  return values;
}

/**
 * 解析要传给 set_config_option 的模型值。
 * @param options 会话返回的配置项列表（session/new 的 configOptions）。
 * @param desired OPENCODE_MODEL 的原始值；留空表示不指定（返回 undefined，沿用 opencode 默认）。
 * @returns 校验通过的模型值，或 undefined（未配置）。
 * @throws 配置了模型但会话没有 model 配置项，或值不在可选列表内。
 */
export function resolveModelValue(
  options: ReadonlyArray<ModelOption> | null | undefined,
  desired: string,
): string | undefined {
  const want = desired.trim();
  if (!want) return undefined;
  const modelOption = options?.find((option) => option.id === "model" || option.category === "model");
  if (!modelOption) {
    throw new Error(`配置了 OPENCODE_MODEL=${want}，但 OpenCode 这次会话没有提供 model 配置项`);
  }
  const values = optionValues(modelOption);
  if (values.size > 0 && !values.has(want)) {
    throw new Error(`OPENCODE_MODEL=${want} 不在可选模型内：${[...values].join("、")}`);
  }
  return want;
}
