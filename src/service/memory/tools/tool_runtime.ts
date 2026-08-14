import type { ToolRunnableConfig } from '@langchain/core/tools'

export type LivingMemoryToolConfigurable = {
    preset?: unknown
}

export const getLivingMemoryToolConfigurable = (
    runConfig?: ToolRunnableConfig
) => {
    return runConfig?.configurable as LivingMemoryToolConfigurable | undefined
}
