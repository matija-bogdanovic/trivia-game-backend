import AWS from "aws-sdk";

AWS.config.update({
  region: process.env.REGION || "eu-west-3",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_ACCESS_SECRET_KEY,
});

const docClient = new AWS.DynamoDB.DocumentClient();

module.exports = docClient;