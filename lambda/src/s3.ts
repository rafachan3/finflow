import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({});

function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "audio/ogg") return "ogg";
  return "jpg";
}

/** `{source}/{yyyy-mm}/{id}.{ext}`; the month is Toronto's, so 03:00Z on Nov 1 is still October. */
export function mediaKey(args: {
  source: "photo" | "voice";
  ingestionId: string;
  contentType: string;
  now?: Date;
}): string {
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
  }).format(args.now ?? new Date());
  return `${args.source}/${month}/${args.ingestionId}.${extensionFor(args.contentType)}`;
}

export async function putReceipt(args: {
  bucket: string;
  source: "photo" | "voice";
  ingestionId: string;
  body: Buffer;
  contentType: string;
}): Promise<string> {
  const key = mediaKey(args);
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
