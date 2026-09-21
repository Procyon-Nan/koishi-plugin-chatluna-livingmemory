import { describe, expect, it } from 'vitest'
import { elementsToLogText } from '../src/service/transcript/message_log/element_text'

const text = (content: string) => ({ type: 'text', attrs: { content } })

/** 用户实测的哔哩哔哩小程序分享载荷（QQ OneBot json 段 data 字段）。 */
const bilibiliCardPayload = JSON.stringify({
    config: { height: 0, forward: 1, ctime: 1789992694, width: 0 },
    prompt: '[QQ小程序]孩子永远是父母的软肋',
    app: 'com.tencent.miniapp_01',
    ver: '0.0.0.1',
    appID: '100951776',
    view: 'view_8C8E89B49BE609866298ADDFF2DBABA4',
    meta: {
        detail_1: {
            appid: '1109937557',
            preview:
                'https://pic.ugcimg.cn/c552481263433d87bbba2dfbf76ca753/jpg1',
            url: 'm.q.qq.com/a/s/d2a29c21db9e61d31832dd65e28b66b8',
            appType: 0,
            desc: '孩子永远是父母的软肋',
            title: '哔哩哔哩',
            scene: 1036,
            host: { uin: 2829184957, nick: '祁諾' },
            icon: 'https://open.gtimg.cn/open/app_icon/00/95/17/76/100951776_100_m.png',
            qqdocurl: 'https://b23.tv/GElgy7s'
        }
    },
    desc: ''
})

describe('elementsToLogText', () => {
    it('joins text elements and trims the result', () => {
        expect(elementsToLogText([text(' 你好 '), text('世界')])).toBe(
            '你好 世界'
        )
    })

    it('returns empty for missing or empty elements', () => {
        expect(elementsToLogText(null)).toBe('')
        expect(elementsToLogText([])).toBe('')
    })

    it('renders media and file placeholders, keeping available names', () => {
        expect(
            elementsToLogText([
                { type: 'img', attrs: { src: 'https://example.test/a.jpg' } },
                { type: 'audio', attrs: { src: 'b.silk' } },
                { type: 'video', attrs: {} },
                { type: 'file', attrs: { name: '报告.pdf' } },
                { type: 'file', attrs: {} }
            ])
        ).toBe('[图片][语音][视频][文件:报告.pdf][文件]')
    })

    it('renders face names when available', () => {
        expect(
            elementsToLogText([
                { type: 'face', attrs: { id: '4', name: '得意' } },
                { type: 'face', attrs: { id: '999999' } }
            ])
        ).toBe('[表情:得意][表情]')
    })

    it('renders forwards with the Milky title and summary when present', () => {
        expect(
            elementsToLogText([
                { type: 'forward', attrs: { id: '7688043919364654622' } },
                {
                    type: 'milky:forward',
                    attrs: {
                        forwardId: 'f-1',
                        title: '群聊的聊天记录',
                        summary: '用户A: 早 用户B: 晚'
                    }
                }
            ])
        ).toBe('[聊天记录][聊天记录:群聊的聊天记录 用户A: 早 用户B: 晚]')
    })

    it('treats message elements with a forward attribute as forwards', () => {
        expect(
            elementsToLogText([
                { type: 'message', attrs: { forward: 'true' } },
                { type: 'message', attrs: {} }
            ])
        ).toBe('[聊天记录][非文本消息]')
    })

    it('extracts the key fields of a QQ json card', () => {
        expect(
            elementsToLogText([
                { type: 'json', attrs: { data: bilibiliCardPayload } }
            ])
        ).toBe('[卡片:哔哩哔哩] [QQ小程序]孩子永远是父母的软肋（分享者：祁諾）')
    })

    it('uses the Milky app name and payload for light-app cards', () => {
        expect(
            elementsToLogText([
                {
                    type: 'milky:light-app',
                    attrs: {
                        appName: '哔哩哔哩',
                        jsonPayload: bilibiliCardPayload
                    }
                }
            ])
        ).toBe('[卡片:哔哩哔哩] [QQ小程序]孩子永远是父母的软肋（分享者：祁諾）')
    })

    it('degrades json cards with invalid payloads to a plain placeholder', () => {
        expect(
            elementsToLogText([
                { type: 'json', attrs: { data: '{not-json' } },
                { type: 'xml', attrs: { data: '<xml/>' } }
            ])
        ).toBe('[卡片消息][卡片消息]')
    })

    it('renders minor OneBot segment placeholders', () => {
        expect(
            elementsToLogText([
                {
                    type: 'share',
                    attrs: { url: 'https://example.test', title: '新闻' }
                },
                { type: 'share', attrs: {} },
                {
                    type: 'location',
                    attrs: { lat: '1', lng: '2', title: '家里' }
                },
                { type: 'contact', attrs: { type: 'qq', id: '10000' } },
                { type: 'dice', attrs: { value: '5' } },
                { type: 'rps', attrs: {} },
                { type: 'mface', attrs: { name: '让我看看' } },
                { type: 'quote', attrs: { id: 'q-1' } }
            ])
        ).toBe(
            '[分享:新闻][分享][位置:家里][联系人][骰子][猜拳][表情包:让我看看][引用回复]'
        )
    })

    it('resolves at labels through the resolver and falls back to the id', () => {
        expect(
            elementsToLogText(
                [
                    { type: 'at', attrs: { id: 'user-2', name: '群名片B' } },
                    { type: 'at', attrs: { id: 'user-3' } },
                    { type: 'at', attrs: { type: 'all' } },
                    { type: 'at', attrs: {} }
                ],
                (userId) => (userId === 'user-2' ? '用户昵称B' : null)
            )
        ).toBe('@用户昵称B@user-3@全体成员[非文本消息]')
    })

    it('falls back to the at id without a resolver', () => {
        expect(
            elementsToLogText([{ type: 'at', attrs: { id: 'user-2' } }])
        ).toBe('@user-2')
    })

    it('replaces unknown element types with a generic placeholder', () => {
        expect(
            elementsToLogText([
                text('未知之后'),
                { type: 'future-widget', attrs: {} }
            ])
        ).toBe('未知之后[非文本消息]')
    })

    it('extracts text inside formatting containers with line breaks', () => {
        expect(
            elementsToLogText([
                {
                    type: 'p',
                    children: [
                        text('明天'),
                        { type: 'b', children: [text('下午三点')] },
                        text('开会')
                    ]
                },
                { type: 'p', children: [text('收到')] },
                { type: 'spl', children: [text('隐藏文字')] },
                { type: 'code', children: [text('yarn lint')] }
            ])
        ).toBe('明天下午三点开会\n收到\n隐藏文字yarn lint')
    })

    it('keeps whitespace and line breaks at container boundaries', () => {
        expect(
            elementsToLogText([
                { type: 'b', children: [text('Hello ')] },
                text('world')
            ])
        ).toBe('Hello world')
        expect(
            elementsToLogText([
                { type: 'b', children: [text('first'), { type: 'br' }] },
                text('second')
            ])
        ).toBe('first\nsecond')
    })

    it('keeps link labels and falls back to the href without label text', () => {
        expect(
            elementsToLogText([
                {
                    type: 'a',
                    attrs: { href: 'https://example.test/doc' },
                    children: [text('文档')]
                },
                { type: 'a', attrs: { href: 'https://example.test/raw' } }
            ])
        ).toBe('文档[链接:https://example.test/raw]')
    })

    it('converts br elements into newlines', () => {
        expect(
            elementsToLogText([text('第一行'), { type: 'br' }, text('第二行')])
        ).toBe('第一行\n第二行')
    })
})
