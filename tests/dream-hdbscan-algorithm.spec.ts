import assert from 'node:assert/strict'
import {
    buildDreamMst,
    type DreamHdbscanMatrix,
    runDreamHdbscan
} from '../src/service/workflows/dream/hdbscan/algorithm'

const createMatrix = (rows: number[][]): DreamHdbscanMatrix => ({
    entryCount: rows.length,
    dimension: rows[0]?.length ?? 0,
    vectors: new Float32Array(rows.flat())
})

const normalizeRows = (rows: number[][]) =>
    rows.map((row) => {
        const norm = Math.sqrt(
            row.reduce((sum, value) => sum + value * value, 0)
        )
        return row.map((value) => value / norm)
    })

const squaredDistance = (left: number[], right: number[]) =>
    left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0)

const buildDenseReferenceMst = (matrix: DreamHdbscanMatrix) => {
    const rows = Array.from({ length: matrix.entryCount }, (_, entry) =>
        Array.from(
            { length: matrix.dimension },
            (_, dimension) =>
                matrix.vectors[entry * matrix.dimension + dimension]
        )
    )
    const normalized = normalizeRows(rows)
    const visited = new Set([0])
    const bestDistance = new Array(rows.length).fill(Number.POSITIVE_INFINITY)
    const parent = new Array(rows.length).fill(-1)
    const edges: ReturnType<typeof buildDreamMst> = []

    for (let index = 1; index < rows.length; index++) {
        bestDistance[index] = squaredDistance(normalized[0], normalized[index])
        parent[index] = 0
    }
    while (visited.size < rows.length) {
        let next = -1
        let minimum = Number.POSITIVE_INFINITY
        for (let index = 0; index < rows.length; index++) {
            if (!visited.has(index) && bestDistance[index] < minimum) {
                next = index
                minimum = bestDistance[index]
            }
        }
        edges.push({
            left: parent[next],
            right: next,
            distance: minimum,
            order: edges.length
        })
        visited.add(next)
        for (let index = 0; index < rows.length; index++) {
            if (visited.has(index)) {
                continue
            }
            const candidate = squaredDistance(
                normalized[next],
                normalized[index]
            )
            if (candidate < bestDistance[index]) {
                bestDistance[index] = candidate
                parent[index] = next
            }
        }
    }
    return edges
}

const canonicalizeLabels = (labels: ArrayLike<number>) => {
    const clusters = new Map<number, number[]>()
    const noise: number[] = []
    for (let index = 0; index < labels.length; index++) {
        const label = labels[index]
        if (label === -1) {
            noise.push(index)
            continue
        }
        const cluster = clusters.get(label)
        if (cluster === undefined) {
            clusters.set(label, [index])
        } else {
            cluster.push(index)
        }
    }
    return {
        clusters: [...clusters.values()].sort(
            (left, right) => left[0] - right[0]
        ),
        noise
    }
}

const assertValidLabels = (labels: ArrayLike<number>, entryCount: number) => {
    assert.equal(labels.length, entryCount)
    const clusters = new Set<number>()
    for (let index = 0; index < labels.length; index++) {
        const label = labels[index]
        assert.ok(Number.isInteger(label))
        assert.ok(label >= -1)
        if (label >= 0) {
            clusters.add(label)
        }
    }
    assert.deepEqual(
        [...clusters].sort((left, right) => left - right),
        Array.from({ length: clusters.size }, (_, index) => index)
    )
}

it('builds the same MST as the dense reference', () => {
    let state = 0x12345678
    const random = () => {
        state = (1664525 * state + 1013904223) >>> 0
        return state / 0x1_0000_0000
    }
    const rows = Array.from({ length: 32 }, () =>
        Array.from({ length: 24 }, random)
    )

    const matrix = createMatrix(rows)
    assert.deepEqual(buildDreamMst(matrix), buildDenseReferenceMst(matrix))
})

it('preserves deterministic two-cluster membership', () => {
    const rows = [
        [1, 0.01],
        [1, 0.02],
        [0.99, 0.01],
        [0.01, 1],
        [0.02, 1],
        [0.01, 0.99]
    ]
    const first = runDreamHdbscan(createMatrix(rows))
    const second = runDreamHdbscan(createMatrix(rows))

    assert.deepEqual([...second], [...first])
    assert.deepEqual(canonicalizeLabels(first), {
        clusters: [
            [0, 1, 2],
            [3, 4, 5]
        ],
        noise: []
    })
})

it('keeps a two-memory Dream candidate as one cluster', () => {
    const labels = runDreamHdbscan(
        createMatrix([
            [1, 0],
            [0.99, 0.01]
        ])
    )
    assert.deepEqual([...labels], [0, 0])
})

it('handles duplicate vectors without unstable labels', () => {
    const labels = runDreamHdbscan(
        createMatrix([
            [1, 0],
            [1, 0],
            [0, 1],
            [0, 1]
        ])
    )
    assert.deepEqual(canonicalizeLabels(labels), {
        clusters: [
            [0, 1],
            [2, 3]
        ],
        noise: []
    })
})

it('keeps separated clusters while leaving isolated entries as noise', () => {
    const rows = [
        [1, 0],
        [0.99, 0.01],
        [0, 1],
        [0.01, 0.99],
        [-1, 0]
    ]
    const labels = runDreamHdbscan(createMatrix(rows))

    assert.deepEqual(canonicalizeLabels(labels), {
        clusters: [
            [0, 1],
            [2, 3]
        ],
        noise: [4]
    })
    assertValidLabels(labels, rows.length)
})

it('keeps only the densest core of a single root cluster', () => {
    const rows = [
        [1, 0],
        [0.99, 0.01],
        [0.98, 0.02],
        [-1, 0],
        [0, -1]
    ]
    const labels = runDreamHdbscan(createMatrix(rows))

    assert.deepEqual([...labels], [0, 0, -1, -1, -1])
    assertValidLabels(labels, rows.length)
})

it('allows one root cluster when all points leave at the same density', () => {
    const rows = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1]
    ]
    const labels = runDreamHdbscan(createMatrix(rows))

    assert.deepEqual([...labels], [0, 0, 0, 0])
    assertValidLabels(labels, rows.length)
})

it('uses stable index order when MST distances tie', () => {
    const matrix = createMatrix([
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1]
    ])

    assert.deepEqual(buildDreamMst(matrix), [
        { left: 0, right: 1, distance: 2, order: 0 },
        { left: 1, right: 2, distance: 2, order: 1 },
        { left: 0, right: 3, distance: 2, order: 2 }
    ])
})

it('keeps the fixed regression fixture deterministic', () => {
    let state = 0x9e3779b9
    const random = () => {
        state = (1664525 * state + 1013904223) >>> 0
        return state / 0x1_0000_0000
    }
    const rows = Array.from({ length: 48 }, () => [
        random(),
        random(),
        random(),
        random()
    ])
    const first = runDreamHdbscan(createMatrix(rows))
    const second = runDreamHdbscan(createMatrix(rows))

    assert.deepEqual([...second], [...first])
    assertValidLabels(first, rows.length)
})

it('reports bounded progress for every algorithm phase', () => {
    const progress: string[] = []
    runDreamHdbscan(
        createMatrix(
            Array.from({ length: 64 }, (_, index) => [
                Math.cos(index),
                Math.sin(index),
                1
            ])
        ),
        ({ phase, completed, total }) => {
            assert.ok(completed >= 0)
            assert.ok(completed <= total)
            progress.push(phase)
        }
    )

    assert.ok(progress.includes('normalizing'))
    assert.ok(progress.includes('building-mst'))
    assert.ok(progress.includes('building-hierarchy'))
    assert.ok(progress.includes('selecting-clusters'))
    assert.ok(progress.length < 40)
})

it('preserves representative cluster membership', () => {
    const fixtures = [
        {
            rows: [
                [1, 0],
                [1, 0],
                [0, 1],
                [0, 1]
            ],
            clusters: [
                [0, 1],
                [2, 3]
            ]
        },
        {
            rows: [
                [1, 0],
                [1, 0.001],
                [1, 0.002],
                [1, 0.003],
                [0, 1],
                [0.001, 1],
                [0.002, 1],
                [0.003, 1]
            ],
            clusters: [
                [0, 1, 2, 3],
                [4, 5, 6, 7]
            ]
        }
    ]

    for (const fixture of fixtures) {
        assert.deepEqual(
            canonicalizeLabels(runDreamHdbscan(createMatrix(fixture.rows))),
            {
                clusters: fixture.clusters,
                noise: []
            }
        )
    }
})
