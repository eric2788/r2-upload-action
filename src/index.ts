import { getInput, setFailed, setOutput } from "@actions/core";
import {
    AbortMultipartUploadCommand,
    AbortMultipartUploadCommandInput,
    CompleteMultipartUploadCommand,
    CompleteMultipartUploadCommandInput,
    CreateMultipartUploadCommand,
    CreateMultipartUploadCommandInput,
    PutObjectCommand,
    PutObjectCommandInput,
    S3Client,
    S3ServiceException,
    UploadPartCommand,
    UploadPartCommandInput
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from "fs";
import md5 from "md5";
import mime from "mime";
import path from "path";
import { FileMap, R2Config } from "./types.js";


type UploadHandler = (file: string, config: R2Config) => Promise<string>;

let config: R2Config = {
    accountId: getInput("r2-account-id", { required: true }),
    accessKeyId: getInput("r2-access-key-id", { required: true }),
    secretAccessKey: getInput("r2-secret-access-key", { required: true }),
    bucket: getInput("r2-bucket", { required: true }),
    sourceDir: getInput("source-dir", { required: true }),
    destinationDir: getInput("destination-dir"),
    outputFileUrl: getInput("output-file-url") === 'true',
    multiPartSize: parseInt(getInput("multipart-size")) || 100,
    maxTries: parseInt(getInput("max-tries")) || 5
};

const S3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
    }
});

const getFileList = (dir: string) => {
    let files: string[] = [];
    const items = fs.readdirSync(dir, {
        withFileTypes: true,
    });

    for (const item of items) {
        const isDir = item.isDirectory();
        const absolutePath = `${dir}/${item.name}`;
        if (isDir) {
            files = [...files, ...getFileList(absolutePath)];
        } else {
            files.push(absolutePath);
        }
    }

    return files;
};

const formatBytes = function(bytes: number): string {
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
  
    if (bytes == 0) {
      return "0 Bytes"
    }
  
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
  
    if (i == 0) {
      return bytes + " " + sizes[i]
    }
  
    return (bytes / Math.pow(1024, i)).toFixed(2) + " " + sizes[i]
  }

const getFileSizeMB = (file: string) => {
    return fs.statSync(file).size / (1024 * 1024);
}

const formatFileSize = (file: string) => {
    return formatBytes(fs.statSync(file).size);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const run = async (config: R2Config) => {
    const urls: FileMap = {};

    const files: string[] = getFileList(config.sourceDir);

    for (const file of files) {

        await sleep(300);

        //const fileName = file.replace(/^.*[\\\/]/, "");
        const fileName = file.replace(config.sourceDir, "");
        const fileKey = path.join(config.destinationDir !== "" ? config.destinationDir : config.sourceDir, fileName);

        if (fileKey.includes('.gitkeep'))
            continue;

        try {
            const fileMB = getFileSizeMB(file);
            console.info(`R2 Info - Uploading ${file} (${formatFileSize(file)}) to ${fileKey}`);
            const upload = fileMB > config.multiPartSize ? uploadMultiPart : putObject;
            const fileUrl = await upload(file, config);
            urls[file] = fileUrl;
        } catch (err: unknown) {
            const error = err as S3ServiceException;
            if (error.hasOwnProperty("$metadata")) {
                if (error.$metadata.httpStatusCode !== 412) // If-None-Match
                    throw error;
            } else {
                // normal error, throw it
                console.error(`Error while uploading ${file} to ${fileKey}: `, err)
                throw error;
            }
        }
    }

    if (config.outputFileUrl) setOutput('file-urls', urls);
};

const uploadMultiPart = async (file: string, config: R2Config) => {

    const fileName = file.replace(config.sourceDir, "");
    const fileKey = path.join(config.destinationDir !== "" ? config.destinationDir : config.sourceDir, fileName);
    const mimeType = mime.getType(file);

    console.log('using multipart upload for ', fileKey)

    const createMultiPartParams: CreateMultipartUploadCommandInput = {
        Bucket: config.bucket,
        Key: fileKey,
        ContentType: mimeType ?? 'application/octet-stream'
    }

    const cmd = new CreateMultipartUploadCommand(createMultiPartParams);

    const created = await S3.send(cmd);

    const chunkSize = 10 * 1024 * 1024; // 10MB

    const multiPartMap = {
        Parts: []
    }

    const totalSize = formatFileSize(file);
    let bytesRead = 0;
    let partNumber = 0;
    for await (const chunk of readFixedChunkSize(file, chunkSize)) {

        const uploadPartParams: UploadPartCommandInput = {
            Bucket: config.bucket,
            Key: fileKey,
            PartNumber: ++partNumber,
            UploadId: created.UploadId,
            Body: chunk,
        }

        const cmd = new UploadPartCommand(uploadPartParams);
        let retries = 0
        while (retries < config.maxTries) {
            try {
                const result = await S3.send(cmd);
                multiPartMap.Parts.push({ PartNumber: partNumber, ETag: result.ETag });
                break;
            } catch (err: any) {
                retries++;
                console.error(`R2 Error - ${err.message}, retrying: ${retries}/${config.maxTries}`, err);
                await sleep(300);
            }
        }
        if (retries >= config.maxTries) {
            console.info(`Retries exhausted, aborting upload`)
            const abortParams: AbortMultipartUploadCommandInput = {
                Bucket: config.bucket,
                Key: fileKey,
                UploadId: created.UploadId
            }
            const cmd = new AbortMultipartUploadCommand(abortParams);
            await S3.send(cmd);
            throw new Error(`R2 Error - Failed to upload part ${partNumber} of ${file}`);
        }
        bytesRead += chunk.byteLength;
        console.info(`R2 Success - Uploaded part ${formatBytes(bytesRead)}/${totalSize} of ${file} (${partNumber})`)
    }

    console.info(`R2 Info - Completed upload of ${file} to ${fileKey}`)

    const completeMultiPartUploadParams: CompleteMultipartUploadCommandInput = {
        Bucket: config.bucket,
        Key: fileKey,
        UploadId: created.UploadId,
        MultipartUpload: multiPartMap
    }

    const completeCmd = new CompleteMultipartUploadCommand(completeMultiPartUploadParams);
    await S3.send(completeCmd);
    return await getSignedUrl(S3, completeCmd);
}


const putObject: UploadHandler = async (file, config) => {
    const fileName = file.replace(config.sourceDir, "");
    const fileKey = path.join(config.destinationDir !== "" ? config.destinationDir : config.sourceDir, fileName);
    const mimeType = mime.getType(file);

    console.info(`using put object upload for ${fileKey}`);

    const fileStream = fs.readFileSync(file);
    const uploadParams: PutObjectCommandInput = {
        Bucket: config.bucket,
        Key: fileKey,
        Body: fileStream,
        ContentLength: fs.statSync(file).size,
        ContentType: mimeType ?? 'application/octet-stream'
    };
    const cmd = new PutObjectCommand(uploadParams);
    const digest = md5(fileStream);
    cmd.middlewareStack.add((next: any) => async (args: any) => {
        args.request.headers['if-none-match'] = `"${digest}"`;
        return await next(args);
    }, {
        step: 'build',
        name: 'addETag'
    });
    await S3.send(cmd);
    console.log(`R2 Success - ${file}`);
    return await getSignedUrl(S3, cmd);
}

async function* readFixedChunkSize(file: string, chunkSize: number): AsyncIterable<Buffer> {
    const stream = fs.createReadStream(file);
    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= chunkSize) {
            yield buffer.subarray(0, chunkSize);
            buffer = buffer.subarray(chunkSize);
        }
    }

    if (buffer.length > 0) {
        yield buffer;
    }
}

run(config)
    .then(() => setOutput('result', 'success'))
    .catch(err => {
        if (err.hasOwnProperty('$metadata')) {
            console.error(`R2 Error - ${err.message}`);
        } else {
            console.error('Error', err);
        }

        setOutput('result', 'failure');
        setFailed(err.message);
    }).finally(() => S3.destroy());