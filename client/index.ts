import { Context, icons } from '@koishijs/client'
import type {} from './types'
import Dashboard from './dashboard.vue'
import TreeOfLife from './icons/tree-of-life.vue'

icons.register('living-memory-tree', TreeOfLife)

export default (ctx: Context) => {
    ctx.page({
        name: 'Living Memory',
        path: '/chatluna-livingmemory',
        icon: 'living-memory-tree',
        component: Dashboard,
        order: 500,
        authority: 3
    })
}
