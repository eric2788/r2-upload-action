export interface R2Config {
    accountId: string
    accessKeyId: string
    secretAccessKey: string
    bucket: string
    sourceDir: string
    destinationDir: string
    outputFileUrl: boolean
    multiPartSize: number
    maxTries: number
}

export interface FileMap {
    [file: string]: string
}