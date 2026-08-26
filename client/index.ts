import { Context, icons } from '@koishijs/client'
import dashboard from './dashboard.vue'
import treeOfLife from './icons/tree-of-life.vue'

icons.register('living-memory-tree', treeOfLife)

export default (ctx: Context) => {
    ctx.page({
        name: 'Living Memory',
        path: '/chatluna-livingmemory',
        icon: 'living-memory-tree',
        component: dashboard,
        order: 500,
        authority: 3
    })
}
