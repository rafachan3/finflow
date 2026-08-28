import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({});

export async function putReceipt(args: {
  bucket: string;
  ingestionId: string;
  body: Buffer;
  contentType: string;
}): Promise<string> {
  const key = `${args.ingestionId}.jpg`;
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
