import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({});

function extensionFor(contentType: string): string {
  return contentType === "image/png" ? "png" : "jpg";
}

export async function putReceipt(args: {
  bucket: string;
  ingestionId: string;
  body: Buffer;
  contentType: string;
}): Promise<string> {
  const key = `${args.ingestionId}.${extensionFor(args.contentType)}`;
  await client.send(
    new PutObjectCommand({
      Bucket: args.bucket,
      Key: key,
      Body: args.body,
      ContentType: args.contentType,
    }),
  );
  return key;
}
