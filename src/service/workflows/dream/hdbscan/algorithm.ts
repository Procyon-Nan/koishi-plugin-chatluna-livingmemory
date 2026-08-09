const MIN_CLUSTER_SIZE = 2

export interface DreamHdbscanMatrix {
    entryCount: number
    dimension: number
    vectors: Float32Array<ArrayBuffer>
}

export type DreamHdbscanPhase =
    'normalizing' | 'building-mst' | 'building-hierarchy' | 'selecting-clusters'

export interface DreamHdbscanProgress {
    phase: DreamHdbscanPhase
    completed: number
    total: number
}

export type DreamHdbscanProgressReporter = (
    progress: DreamHdbscanProgress
) => void

export interface DreamMstEdge {
    left: number
    right: number
    distance: number
    order: number
}

interface NormalizedMatrix {
    entryCount: number
    dimension: number
    vectors: Float64Array<ArrayBuffer>
}

interface SingleLinkageNode {
    left: number
    right: number
    distance: number
    size: number
}

interface CondensedEdge {
    parent: number
    child: number
    lambda: number
    childSize: number
}

export const runDreamHdbscan = (
    input: DreamHdbscanMatrix,
    report?: DreamHdbscanProgressReporter
) => {
    if (input.entryCount === 0) {
        return new Int32Array()
    }
    if (input.entryCount === 1) {
        return new Int32Array([-1])
    }
    if (input.entryCount === MIN_CLUSTER_SIZE) {
        return new Int32Array([0, 0])
    }

    report?.({
        phase: 'normalizing',
        completed: 0,
        total: input.entryCount
    })
    const normalized = normalizeMatrix(input)
    report?.({
        phase: 'normalizing',
        completed: input.entryCount,
        total: input.entryCount
    })

    const mst = buildNormalizedMst(normalized, report)
    report?.({
        phase: 'building-hierarchy',
        completed: 0,
        total: input.entryCount - 1
    })
    const hierarchy = buildSingleLinkageTree(input.entryCount, mst)
    const condensed = condenseTree(input.entryCount, hierarchy)
    report?.({
        phase: 'building-hierarchy',
        completed: input.entryCount - 1,
        total: input.entryCount - 1
    })
    report?.({
        phase: 'selecting-clusters',
        completed: 0,
        total: condensed.length
    })
    const labels = selectClusters(input.entryCount, condensed)
    report?.({
        phase: 'selecting-clusters',
        completed: condensed.length,
        total: condensed.length
    })
    return labels
}

export const buildDreamMst = (input: DreamHdbscanMatrix) =>
    buildNormalizedMst(normalizeMatrix(input))

const normalizeMatrix = (input: DreamHdbscanMatrix): NormalizedMatrix => {
    const normalized = new Float64Array(input.vectors.length)
    for (let entry = 0; entry < input.entryCount; entry++) {
        const offset = entry * input.dimension
        let normSquare = 0
        for (let dimension = 0; dimension < input.dimension; dimension++) {
            const value = input.vectors[offset + dimension]
            normSquare += value * value
        }
        const norm = Math.sqrt(normSquare)
        for (let dimension = 0; dimension < input.dimension; dimension++) {
            normalized[offset + dimension] =
                input.vectors[offset + dimension] / norm
        }
    }
    return {
        entryCount: input.entryCount,
        dimension: input.dimension,
        vectors: normalized
    }
}

// minSamples 固定为 1，core distance 不会扩大任意点对距离；
// mutual reachability graph 因此等同于当前的平方欧氏距离完整图。
const buildNormalizedMst = (
    matrix: NormalizedMatrix,
    report?: DreamHdbscanProgressReporter
) => {
    const { entryCount } = matrix
    const visited = new Uint8Array(entryCount)
    const bestDistance = new Float64Array(entryCount)
    const parent = new Int32Array(entryCount)
    const edges: DreamMstEdge[] = []
    bestDistance.fill(Number.POSITIVE_INFINITY)
    parent.fill(-1)
    visited[0] = 1

    for (let index = 1; index < entryCount; index++) {
        bestDistance[index] = squaredDistance(matrix, 0, index)
        parent[index] = 0
    }

    const total = entryCount - 1
    const progressInterval = Math.max(1, Math.floor(total / 20))
    report?.({ phase: 'building-mst', completed: 0, total })

    for (let completed = 0; completed < total; completed++) {
        let next = -1
        let minimum = Number.POSITIVE_INFINITY
        for (let index = 0; index < entryCount; index++) {
            if (visited[index] === 0 && bestDistance[index] < minimum) {
                next = index
                minimum = bestDistance[index]
            }
        }

        edges.push({
            left: parent[next],
            right: next,
            distance: minimum,
            order: completed
        })
        visited[next] = 1

        for (let index = 0; index < entryCount; index++) {
            if (visited[index] !== 0) {
                continue
            }
            const candidate = squaredDistance(matrix, next, index)
            if (candidate < bestDistance[index]) {
                bestDistance[index] = candidate
                parent[index] = next
            }
        }

        const processed = completed + 1
        if (processed === total || processed % progressInterval === 0) {
            report?.({ phase: 'building-mst', completed: processed, total })
        }
    }
    return edges
}

const squaredDistance = (
    matrix: NormalizedMatrix,
    left: number,
    right: number
) => {
    const leftOffset = left * matrix.dimension
    const rightOffset = right * matrix.dimension
    let distance = 0
    for (let index = 0; index < matrix.dimension; index++) {
        const delta =
            matrix.vectors[leftOffset + index] -
            matrix.vectors[rightOffset + index]
        distance += delta ** 2
    }
    return distance
}

const buildSingleLinkageTree = (entryCount: number, mst: DreamMstEdge[]) => {
    const orderedEdges = [...mst].sort(
        (left, right) =>
            left.distance - right.distance || left.order - right.order
    )
    const parent = new Int32Array(entryCount * 2 - 1)
    const sizes = new Int32Array(entryCount * 2 - 1)
    for (let index = 0; index < parent.length; index++) {
        parent[index] = index
    }
    sizes.fill(1, 0, entryCount)

    const hierarchy: SingleLinkageNode[] = []
    orderedEdges.forEach((edge, index) => {
        const left = findRoot(parent, edge.left)
        const right = findRoot(parent, edge.right)
        const cluster = entryCount + index
        const size = sizes[left] + sizes[right]
        hierarchy.push({ left, right, distance: edge.distance, size })
        parent[left] = cluster
        parent[right] = cluster
        parent[cluster] = cluster
        sizes[cluster] = size
    })
    return hierarchy
}

const findRoot = (parent: Int32Array, start: number) => {
    let root = start
    while (parent[root] !== root) {
        root = parent[root]
    }
    let node = start
    while (parent[node] !== node) {
        const next = parent[node]
        parent[node] = root
        node = next
    }
    return root
}

const condenseTree = (entryCount: number, hierarchy: SingleLinkageNode[]) => {
    const root = entryCount * 2 - 2
    const relabel = new Int32Array(root + 1)
    const ignored = new Uint8Array(root + 1)
    const queue = [root]
    const result: CondensedEdge[] = []
    relabel.fill(-1)
    relabel[root] = entryCount
    let nextLabel = entryCount + 1

    for (let offset = 0; offset < queue.length; offset++) {
        const node = queue[offset]
        if (node < entryCount || ignored[node] !== 0) {
            continue
        }
        const children = hierarchy[node - entryCount]
        const { left, right } = children
        queue.push(left, right)
        const lambda =
            children.distance > 0
                ? 1 / children.distance
                : Number.POSITIVE_INFINITY
        const leftSize = linkageNodeSize(entryCount, hierarchy, left)
        const rightSize = linkageNodeSize(entryCount, hierarchy, right)

        if (leftSize >= MIN_CLUSTER_SIZE && rightSize >= MIN_CLUSTER_SIZE) {
            relabel[left] = nextLabel++
            relabel[right] = nextLabel++
            result.push(
                {
                    parent: relabel[node],
                    child: relabel[left],
                    lambda,
                    childSize: leftSize
                },
                {
                    parent: relabel[node],
                    child: relabel[right],
                    lambda,
                    childSize: rightSize
                }
            )
            continue
        }

        if (leftSize < MIN_CLUSTER_SIZE && rightSize < MIN_CLUSTER_SIZE) {
            appendRuntLeaves(
                entryCount,
                hierarchy,
                left,
                relabel[node],
                lambda,
                ignored,
                result
            )
            appendRuntLeaves(
                entryCount,
                hierarchy,
                right,
                relabel[node],
                lambda,
                ignored,
                result
            )
            continue
        }

        if (leftSize < MIN_CLUSTER_SIZE) {
            relabel[right] = relabel[node]
            appendRuntLeaves(
                entryCount,
                hierarchy,
                left,
                relabel[node],
                lambda,
                ignored,
                result
            )
        } else {
            relabel[left] = relabel[node]
            appendRuntLeaves(
                entryCount,
                hierarchy,
                right,
                relabel[node],
                lambda,
                ignored,
                result
            )
        }
    }
    return result
}

const linkageNodeSize = (
    entryCount: number,
    hierarchy: SingleLinkageNode[],
    node: number
) => (node < entryCount ? 1 : hierarchy[node - entryCount].size)

const appendRuntLeaves = (
    entryCount: number,
    hierarchy: SingleLinkageNode[],
    root: number,
    parent: number,
    lambda: number,
    ignored: Uint8Array,
    output: CondensedEdge[]
) => {
    const stack = [root]
    while (stack.length > 0) {
        const node = stack.pop()!
        ignored[node] = 1
        if (node < entryCount) {
            output.push({ parent, child: node, lambda, childSize: 1 })
            continue
        }
        const children = hierarchy[node - entryCount]
        stack.push(children.left, children.right)
    }
}

const selectClusters = (entryCount: number, condensed: CondensedEdge[]) => {
    const root = entryCount
    const stability = computeStability(root, condensed)
    const clusterChildren = new Map<number, number[]>()
    for (const edge of condensed) {
        if (edge.childSize === 1) {
            continue
        }
        const children = clusterChildren.get(edge.parent)
        if (children === undefined) {
            clusterChildren.set(edge.parent, [edge.child])
        } else {
            children.push(edge.child)
        }
    }

    const candidates = [...stability.keys()].sort((left, right) => right - left)
    const selected = new Set(candidates)

    for (const cluster of candidates) {
        const children = clusterChildren.get(cluster) ?? []
        let childStability = 0
        for (const child of children) {
            childStability += stability.get(child) ?? 0
        }
        if (childStability > (stability.get(cluster) ?? 0)) {
            selected.delete(cluster)
            stability.set(cluster, childStability)
            continue
        }
        removeDescendants(cluster, clusterChildren, selected)
    }

    return labelSelectedClusters(entryCount, root, condensed, selected)
}

const computeStability = (root: number, condensed: CondensedEdge[]) => {
    const birth = new Map<number, number>([[root, 0]])
    const stability = new Map<number, number>()
    for (const edge of condensed) {
        if (edge.childSize > 1) {
            birth.set(edge.child, edge.lambda)
        }
        if (!stability.has(edge.parent)) {
            stability.set(edge.parent, 0)
        }
    }
    for (const edge of condensed) {
        const parentBirth = birth.get(edge.parent)!
        let duration = edge.lambda - parentBirth
        if (
            edge.lambda === Number.POSITIVE_INFINITY &&
            parentBirth === Number.POSITIVE_INFINITY
        ) {
            duration = 0
        }
        stability.set(
            edge.parent,
            stability.get(edge.parent)! + duration * edge.childSize
        )
    }
    return stability
}

const removeDescendants = (
    cluster: number,
    childrenByCluster: Map<number, number[]>,
    selected: Set<number>
) => {
    const stack = [...(childrenByCluster.get(cluster) ?? [])]
    while (stack.length > 0) {
        const descendant = stack.pop()!
        selected.delete(descendant)
        stack.push(...(childrenByCluster.get(descendant) ?? []))
    }
}

const labelSelectedClusters = (
    entryCount: number,
    root: number,
    condensed: CondensedEdge[],
    selected: Set<number>
) => {
    if (selected.size === 1 && selected.has(root)) {
        return labelSingleRootCluster(entryCount, root, condensed)
    }

    const maximumNode = condensed.reduce(
        (maximum, edge) => Math.max(maximum, edge.parent, edge.child),
        root
    )
    const parent = new Int32Array(maximumNode + 1)
    const resolved = new Int32Array(maximumNode + 1)
    parent.fill(-1)
    resolved.fill(-2)
    for (const edge of condensed) {
        parent[edge.child] = edge.parent
    }

    const orderedClusters = [...selected].sort((left, right) => left - right)
    const labelByCluster = new Map(
        orderedClusters.map((cluster, label) => [cluster, label])
    )
    for (const cluster of selected) {
        resolved[cluster] = cluster
    }
    resolved[root] = -1

    const resolveCluster = (start: number) => {
        const path: number[] = []
        let node = start
        while (resolved[node] === -2) {
            path.push(node)
            node = parent[node]
        }
        const cluster = resolved[node]
        for (const member of path) {
            resolved[member] = cluster
        }
        return cluster
    }

    const labels = new Int32Array(entryCount)
    labels.fill(-1)
    for (let entry = 0; entry < entryCount; entry++) {
        const cluster = resolveCluster(entry)
        labels[entry] = labelByCluster.get(cluster) ?? -1
    }
    return labels
}

const labelSingleRootCluster = (
    entryCount: number,
    root: number,
    condensed: CondensedEdge[]
) => {
    // 单一 root cluster 只保留在 root 中存活到最高 lambda 的密集核心。
    const exitLambda = new Float64Array(entryCount)
    let rootThreshold = 0
    for (const edge of condensed) {
        if (edge.parent === root && edge.lambda > rootThreshold) {
            rootThreshold = edge.lambda
        }
        if (edge.child < entryCount) {
            exitLambda[edge.child] = edge.lambda
        }
    }

    const labels = new Int32Array(entryCount)
    labels.fill(-1)
    for (let entry = 0; entry < entryCount; entry++) {
        if (exitLambda[entry] >= rootThreshold) {
            labels[entry] = 0
        }
    }
    return labels
}
