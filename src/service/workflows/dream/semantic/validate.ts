import { dreamBatchSize, type DreamPlanLabels } from './types'

export const validateDreamPlan = (
    plan: DreamPlanLabels,
    entryCount: number
) => {
    const { labels, sizes, clusterCount } = plan
    if (
        clusterCount !== Math.ceil(entryCount / dreamBatchSize) ||
        labels.length !== entryCount ||
        sizes.length !== clusterCount
    ) {
        throw new Error('Dream 分组结果尺寸与目标数量不符。')
    }
    const counts = new Uint32Array(clusterCount)
    for (const label of labels) {
        if (label >= clusterCount) throw new Error('Dream 分组标签超出范围。')
        counts[label]++
    }
    for (let label = 0; label < clusterCount; label++) {
        if (
            counts[label] < 1 ||
            counts[label] > dreamBatchSize ||
            counts[label] !== sizes[label]
        ) {
            throw new Error(`Dream 分组容量或计数不符：group=${label}`)
        }
    }
}
