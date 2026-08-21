import { DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import type { Tables } from '../core/ports.js'

export function dynamoTables(region: string): Tables {
  const dynamo = new DynamoDBClient({ region })
  return {
    async delete(name) {
      await dynamo.send(new DeleteTableCommand({ TableName: name }))
    },
  }
}
