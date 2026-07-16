export interface PromptMessages {
    systemPrompt: string
    inputPrompt: string
}

export const escapeXmlText = (value: string) => {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
}

export const formatXmlBlock = (name: string, value: string) => {
    return [`<${name}>`, escapeXmlText(value), `</${name}>`]
}

export const formatPromptMessagesTrace = (prompt: PromptMessages) => {
    return [
        '[system]',
        prompt.systemPrompt,
        '',
        '[human]',
        prompt.inputPrompt
    ].join('\n')
}
