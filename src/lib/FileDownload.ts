import util                   from "util"
import { Readable }           from "stream"
import EventEmitter           from "events"
import request                from "./request"
import { createDecompressor } from "./utils"
import { FileDownloadError }  from "./errors"
import {
    Options,
    OptionsOfUnknownResponseBody,
    Response
} from "got/dist/source"


const debug = util.debuglog("app-request")

export interface FileDownloadState {
    requestOptions   : Options
    response        ?: Response
    downloadedChunks : number
    downloadedBytes  : number
    uncompressedBytes: number
    error           ?: Error | string
}

export interface FileDownloadOptions {
    signal        ?: AbortSignal
    accessToken   ?: string
    requestOptions?: OptionsOfUnknownResponseBody
}

export interface FileDownloadEvents {
    start   : (this: FileDownload, state: FileDownloadState) => void
    progress: (this: FileDownload, state: FileDownloadState) => void
    complete: (this: FileDownload, state: FileDownloadState) => void
}

interface FileDownload {
    on<U extends keyof FileDownloadEvents>(event: U, listener: FileDownloadEvents[U]): this;
    emit<U extends keyof FileDownloadEvents>(event: U, ...args: Parameters<FileDownloadEvents[U]>): boolean;
}

class FileDownload extends EventEmitter
{
    readonly url: string

    private state: FileDownloadState

    constructor(url: string)
    {
        super()
        this.url = url
        this.state = {
            downloadedChunks : 0,
            downloadedBytes  : 0,
            uncompressedBytes: 0,
            requestOptions   : {}
        }
    }

    public getState() {
        return { ...this.state }
    }

    public emit(eventName: string | symbol, ...args: any[]): boolean {
        return super.emit(eventName, this.getState(), ...args)
    }

    /**
     * The actual request will be made immediately but the returned stream will
     * be in paused state. Pipe it to some destination and unpause to actually
     * "consume" the downloaded data.
     */
    public run(options: FileDownloadOptions = {}): Promise<Readable>
    {
        const { signal, accessToken, requestOptions = {} } = options;

        return new Promise((resolve, reject) => {
            
            const options: any = {
                ...requestOptions,
                decompress: false,
                responseType: "buffer",
                throwHttpErrors: false,
                headers: {
                    ...requestOptions.headers,
                    "accept-encoding": "gzip, deflate, br, identity"
                }
            }

            if (accessToken) {
                options.headers.authorization = `Bearer ${accessToken}`
            }

            this.state.requestOptions = { ...options, url: this.url }

            this.emit("start")

            const downloadRequest = request.stream(this.url, options)

            if (signal) {
                const abort = () => {
                    debug("Aborting download request")
                    downloadRequest.destroy()
                };

                signal.addEventListener("abort", abort, { once: true });

                downloadRequest.on("end", () => {
                    signal.removeEventListener("abort", abort)
                });
            }

            downloadRequest.once("end", () => this.emit("complete"));

            // In case the request itself fails --------------------------------
            // downloadRequest.on("error", reject)
            downloadRequest.on("error", error => {
                this.state.error = error
                reject(error)
            })

            // Count downloaded bytes ------------------------------------------
            downloadRequest.on("data", (data: string) => {
                this.state.downloadedBytes += data.length
            });

            // Everything else happens after we get a response -----------------
            downloadRequest.on("response", res => {
                
                // In case we get an error response ----------------------------
                if (res.statusCode >= 400) {
                    return reject(new FileDownloadError({
                        fileUrl: this.url,
                        body: res.body,
                        code: res.statusCode
                    }))
                }

                // Un-compress the response if needed --------------------------
                let decompress = createDecompressor(res);
                res.pipe(decompress)
                
                // Count uncompressed bytes ------------------------------------
                decompress.on("data", (data: string) => {
                    this.state.uncompressedBytes += data.length
                    this.emit("progress")
                });
                
                // Count incoming raw data chunks ------------------------------
                downloadRequest.on("data", () => this.state.downloadedChunks += 1)
                
                // Pause it now. We have only set up the downloading part of the
                // whole pipeline. Caller should pipe to other streams and resume
                decompress.pause()

                resolve(decompress)
            });

            downloadRequest.resume();
        })
    }
}

export default FileDownload
