import { QueryCommand, QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../app.js";

/**
 * Generic function to query DynamoDB table by a secondary index or primary key.
 * @param tableName - DynamoDB table name.
 * @param indexName - (Optional) Secondary index name.
 * @param keyName - Partition key attribute name to query on.
 * @param keyValue - Value of the partition key.
 * @returns The matching items from DynamoDB.
 */
export async function queryByKey(
  tableName: string,
  keyName: string,
  keyValue: string | number,
  indexName?: string
) {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: `${keyName} = :${keyValue}`,
    ExpressionAttributeValues: {
      [`:${keyValue}`]: keyValue,
    },
  };

  if (indexName) {
    params.IndexName = indexName;
  }

  const command = new QueryCommand(params);
  const result = await docClient.send(command);
  return result.Items ?? [];
}
