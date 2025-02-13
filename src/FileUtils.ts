import { Stream, Writer } from "@rdfc/js-runner";
import path from "path";
import { memoryUsage } from "node:process";
import { access, readdir, readFile } from "fs/promises";
import { glob } from "glob";
import AdmZip from "adm-zip";
import { getLoggerFor } from "./utils/logUtil";
import * as zlib from "node:zlib";
import { promisify } from "node:util";

export async function globRead(
    globPattern: string,
    writer: Writer<string | Buffer>,
    wait: number = 0,
    closeOnEnd: boolean = true,
    binary: boolean = false,
) {
    const logger = getLoggerFor("globRead");

    const jsfiles = await glob(globPattern, {});

    if (jsfiles.length === 0) {
        logger.warn(`No files found for glob pattern '${globPattern}'. Double check the pattern if this is unexpected.`);
    }

    const files = await Promise.all(
        jsfiles.map((x) => {
            logger.info(`Reading file '${x}' (from glob pattern '${globPattern}')`);
            return readFile(x, binary ? {} : { encoding: "utf8" });
        }),
    );

    let writerClosed = false;
    writer.on("end", () => {
        writerClosed = true;
    });
    // This is a source processor (i.e, the first processor in a pipeline),
    // therefore we should wait until the rest of the pipeline is set
    // to start pushing down data
    return async () => {
        for (const file of files) {
            if (writerClosed) {
                logger.info("Writer closed, so stopping pushing data");
                break;
            }

            await writer.push(file);
            await new Promise((res) => setTimeout(res, wait));
        }

        if (closeOnEnd) {
            // Signal that all files were streamed
            await writer.end();
        }
    };
}

export async function readFolder(
    folder: string,
    writer: Writer<string>,
    maxMemory: number = 3,
    pause: number = 5000,
) {
    const logger = getLoggerFor("readFolder");

    const normalizedPath = path.normalize(folder);

    // Check folder exists
    await access(normalizedPath);

    // Read folder content and iterate over each file
    const fileNames = await readdir(normalizedPath, { recursive: true });
    logger.info(`Reading these files: ${fileNames}`);

    let writerClosed = false;
    writer.on("end", () => {
        writerClosed = true;
    });

    // This is a source processor (i.e, the first processor in a pipeline),
    // therefore we should wait until the rest of the pipeline is set
    // to start pushing down data
    return async () => {
        for (const fileName of fileNames) {
            if (writerClosed) {
                logger.info("Writer closed, so stopping pushing data");
                break;
            }

            // Monitor process memory to avoid high-water memory crashes
            logger.info(`[readFolder] processing '${fileName}'`);
            if (memoryUsage().heapUsed > maxMemory * 1024 * 1024 * 1024) {
                logger.warn(`[readFolder] Phew! too much data (used ${Math.round((memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} Mb)...waiting for ${pause / 1000}s`);
                await sleep(pause);
            }

            await writer.push((await readFile(path.join(normalizedPath, fileName))).toString());
        }

        // Signal that all files were streamed
        await writer.end();
    };
}

function sleep(x: number): Promise<unknown> {
    return new Promise(resolve => setTimeout(resolve, x));
}

export function substitute(
    reader: Stream<string>,
    writer: Writer<string>,
    source: string,
    replace: string,
    regexp = false,
) {
    const logger = getLoggerFor("substitute");

    const reg = regexp ? new RegExp(source) : source;

    let writerClosed = false;
    writer.on("end", async () => {
        logger.info("Writer closed, so closing reader as well.");
        writerClosed = true;
        await reader.end();
    });

    reader.data(async (x) => {
        logger.info(`Replacing '${source}' by '${replace}' on input text`);
        await writer.push(x.replaceAll(reg, replace));
    });
    reader.on("end", async () => {
        if (!writerClosed) {
            await writer.end();
        }
    });
}

export function envsub(reader: Stream<string>, writer: Writer<string>) {
    const logger = getLoggerFor("envsub");

    const env = process.env;

    let writerClosed = false;
    writer.on("end", async () => {
        logger.info("Writer closed, so closing reader as well.");
        writerClosed = true;
        await reader.end();
    });

    reader.data(async (x) => {
        logger.info("Replacing environment variable on input text");
        Object.keys(env).forEach(key => {
            const v = env[key];
            if (v) {
                x = x.replaceAll(`\${${key}}`, v);
            }
        });

        await writer.push(x);
    });
    reader.on("end", async () => {
        if (!writerClosed) {
            await writer.end();
        }
    });
}

export function getFileFromFolder(reader: Stream<string>, folderPath: string, writer: Writer<string>) {
    const logger = getLoggerFor("getFileFromFolder");

    let writerClosed = false;
    writer.on("end", async () => {
        logger.info("Writer closed, so closing reader as well.");
        writerClosed = true;
        await reader.end();
    });

    reader.data(async name => {
        const filePath = path.join(path.resolve(folderPath), name);
        logger.info(`Reading file at '${filePath}'`);
        const file = await readFile(filePath, "utf8");
        await writer.push(file);
    });

    reader.on("end", async () => {
        if (!writerClosed) {
            await writer.end();
        }
    });
}

export function unzipFile(reader: Stream<Buffer>, writer: Writer<string | Buffer>, outputAsBuffer = false) {
    const logger = getLoggerFor("unzipFile");

    let writerClosed = false;
    writer.on("end", async () => {
        logger.info("Writer closed, so closing reader as well.");
        writerClosed = true;
        await reader.end();
    });

    reader.data(async data => {
        try {
            const adm = new AdmZip(data);
            for (const entry of adm.getEntries()) {
                logger.info(`Unzipping received file '${entry.entryName}'`);
                await writer.push(outputAsBuffer ? entry.getData() : entry.getData().toString());
            }
        } catch (ex) {
            logger.error("Ignoring invalid ZIP file received");
            logger.debug(ex);
        }
    });

    reader.on("end", async () => {
        if (!writerClosed) {
            await writer.end();
        }
    });
}

export function gunzipFile(reader: Stream<Buffer>, writer: Writer<string | Buffer>, outputAsBuffer = false) {
    const logger = getLoggerFor("gunzipFile");

    let writerClosed = false;
    writer.on("end", async () => {
        logger.info("Writer closed, so closing reader as well.");
        writerClosed = true;
        await reader.end();
    });

    const gunzip = promisify(zlib.gunzip);

    reader.data(async data => {
        try {
            const buffer = await gunzip(data);

            logger.info("Unzipping received file");
            await writer.push(outputAsBuffer ? buffer : buffer.toString());
        } catch (ex) {
            logger.error("Ignoring invalid GZIP file received");
            console.log(ex);
        }
    });

    reader.on("end", async () => {
        console.log("reader ended");
        if (!writerClosed) {
            await writer.end();
        }
    });
}
