declare module 'fs-native-extensions' {
    export function tryLock(fd: number): boolean
    export function unlock(fd: number): void
}
