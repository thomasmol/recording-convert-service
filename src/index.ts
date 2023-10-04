import { Elysia } from "elysia";
import {
  S3Client,
  type S3ClientConfig,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import ffmpeg from "fluent-ffmpeg";
import { unlinkSync } from "node:fs";

const awsConfig: S3ClientConfig = {
  credentials: {
    accessKeyId: Bun.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: Bun.env.AWS_SECRET_ACCESS_KEY || "",
  },
  region: Bun.env.AWS_REGION,
};

const s3Client: S3Client = new S3Client(awsConfig);

const app = new Elysia();

app.post("/", async (context) => {
  const { fileKey } = context.body as any;
  const s3command = new GetObjectCommand({
    Bucket: Bun.env.AWS_S3_INPUT_BUCKET,
    Key: fileKey,
  });
  const signedUrl = await getSignedUrl(s3Client, s3command, {
    expiresIn: 60 * 10,
  });
  // if filekey is anything but mp3, convert to mp3
  const outputFilePath = fileKey.replace(/\.[^/.]+$/, ".mp3");

  // start converting and wait
  const startTime = Date.now();
  try {
    await processAndUploadFile(signedUrl, outputFilePath);
    const endTime = Date.now();
    return { message: `Job finished in ${endTime - startTime}ms` };
  } catch (error) {
    const endTime = Date.now();
    return { message: `Job error after ${endTime - startTime}ms`, error };
  }
});

app.post("/async", async (context) => {
  const { fileKey, webhookUrl } = context.body as any;
  const s3command = new GetObjectCommand({
    Bucket: Bun.env.AWS_S3_INPUT_BUCKET,
    Key: fileKey,
  });
  const signedUrl = await getSignedUrl(s3Client, s3command, {
    expiresIn: 60 * 10,
  });
  // if filekey is anything but mp3, convert to mp3
  const outputFilePath = fileKey.replace(/\.[^/.]+$/, ".mp3");
  // start converting but don't wait
  processAndUploadFile(signedUrl, outputFilePath, webhookUrl);
  return { message: "Job started" };
});

app.listen(3000);
console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

const processAndUploadFile = async (
  signedUrl: string,
  outputFilePath: string,
  webhookUrl?: string
): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    const command = ffmpeg(signedUrl);
    command
      .audioBitrate(128)
      .noVideo()
      .format("mp3")
      .on("start", (commandLine) =>
        console.log("Spawned Ffmpeg with command: " + commandLine)
      )
      .on("end", async () => {
        try {
          const file = Bun.file(outputFilePath);
          const arrBuffer = await file.arrayBuffer();
          const byteArray = new Uint8Array(arrBuffer);
          const uploadParams = {
            Bucket: Bun.env.AWS_S3_OUTPUT_BUCKET,
            Key: outputFilePath,
            Body: byteArray,
          };
          const response = await s3Client.send(
            new PutObjectCommand(uploadParams)
          );
          if (!response.$metadata.httpStatusCode) {
            throw new Error("Upload to S3 failed");
          }
          console.log("Uploaded to S3");

          if (webhookUrl) {
            await fetch(webhookUrl, {
              method: "POST",
              body: JSON.stringify({ status: "succeeded" }),
            });
            console.log("Sent webhook");
          }
          resolve();
        } catch (error) {
          console.log(error);
          if (webhookUrl) {
            await fetch(webhookUrl, {
              method: "POST",
              body: JSON.stringify({ status: "failed", error }),
            });
          }
          reject(error);
        } finally {
          unlinkSync(outputFilePath);
        }
      })
      .on("error", async (error: Error) => {
        console.log(error);

        // if outputfile exists, delete it
        try {
          unlinkSync(outputFilePath);
        } catch (error) {
          console.log("failed deleting file", error);
        }

        if (webhookUrl) {
          await fetch(webhookUrl, {
            method: "POST",
            body: JSON.stringify({ status: "failed", error }),
          });
        }
        reject(error);
      })
      .save(outputFilePath);
  });
};
