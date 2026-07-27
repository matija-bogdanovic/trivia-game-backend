// One-off: creates the private S3 bucket that stores uploaded profile
// pictures. Safe to re-run — skips if the bucket exists.
import pkg from 'aws-sdk';
const { S3 } = pkg;

export const AVATAR_BUCKET = 'ipak-se-okrece-avatars';
const s3 = new S3({ region: 'eu-west-3' });

try {
  await s3.headBucket({ Bucket: AVATAR_BUCKET }).promise();
  console.log('bucket already exists');
} catch (err) {
  if (err.statusCode !== 404 && err.code !== 'NotFound') throw err;
  await s3
    .createBucket({
      Bucket: AVATAR_BUCKET,
      CreateBucketConfiguration: { LocationConstraint: 'eu-west-3' },
    })
    .promise();
  console.log('bucket created (private):', AVATAR_BUCKET);
}
